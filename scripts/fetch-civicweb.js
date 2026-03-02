const { chromium } = require('playwright');
const { PDFParse, VerbosityLevel } = require('pdf-parse');

const CIVICWEB_BASE = 'https://cityofjerseycity.civicweb.net';
const MEETING_LIST_URL = `${CIVICWEB_BASE}/Portal/MeetingInformation.aspx`;
const MAX_PDF_TEXT_LENGTH = 15000;

/**
 * Extract the direct PDF download URL from a CivicWeb preview page.
 * The preview page contains a "New Window" link with the actual PDF path.
 */
async function findPdfDownloadUrl(page, previewUrl) {
  try {
    await page.goto(previewUrl, { waitUntil: 'networkidle', timeout: 15000 });
    return page.evaluate((base) => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (href.includes('/filepro/document/') && href.endsWith('.pdf')) {
          return href.startsWith('http') ? href : `${base}${href}`;
        }
      }
      return null;
    }, CIVICWEB_BASE);
  } catch {
    return null;
  }
}

/**
 * Download a PDF from a CivicWeb preview URL and extract its text.
 * First finds the direct PDF link from the preview page, then downloads and parses.
 * Returns extracted text (capped at MAX_PDF_TEXT_LENGTH) or null on failure.
 */
async function extractPdfText(page, requestContext, sourceUrl) {
  try {
    // Step 1: Find the actual PDF download URL from the preview page
    const pdfUrl = await findPdfDownloadUrl(page, sourceUrl);
    if (!pdfUrl) return null;

    // Step 2: Download the PDF
    const response = await requestContext.get(pdfUrl, { timeout: 15000 });
    if (response.status() !== 200) return null;

    const buffer = await response.body();
    if (buffer.length < 500) return null;

    // Step 3: Parse PDF text
    const parser = new PDFParse({ data: buffer, verbosity: VerbosityLevel.ERRORS });
    await parser.load();
    const result = await parser.getText();
    await parser.destroy();
    const text = (result.text || '').replace(/\s+/g, ' ').trim();
    return text.length > 0 ? text.slice(0, MAX_PDF_TEXT_LENGTH) : null;
  } catch (err) {
    console.warn(`  Failed to extract PDF from ${sourceUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch list of recent meetings from the CivicWeb portal.
 * Returns array of { title, date, url, meetingId }.
 */
async function fetchMeetingList(page) {
  await page.goto(MEETING_LIST_URL, { waitUntil: 'networkidle', timeout: 30000 });

  return page.evaluate((base) => {
    return Array.from(document.querySelectorAll('a.list-link'))
      .map(a => {
        const text = a.textContent.trim();
        const href = a.getAttribute('href') || '';
        const idMatch = href.match(/id=(\d+)/);
        const dateMatch = text.match(/(\w+ \d{1,2} \d{4})$/);
        return {
          title: text,
          date: dateMatch ? dateMatch[1] : null,
          url: `${base}${href}`,
          meetingId: idMatch ? idMatch[1] : null
        };
      })
      .filter(m => m.meetingId);
  }, CIVICWEB_BASE);
}

/**
 * Map a CivicWeb folder name to a document category.
 */
function categorizeFolder(name) {
  const upper = name.toUpperCase();
  if (upper.includes('ORDINANCES') || upper.includes('RESOLUTIONS')) return 'ordinance';
  if (upper.includes('CONSENT')) return 'consent';
  if (upper.includes('COMMUNICATION') || upper.includes('CORRESPONDENCE')) return 'communication';
  if (upper.includes('EXECUTIVE ORDER')) return 'exec_order';
  return 'other';
}

/**
 * For a given meeting page, find ALL document folder links (not just ordinances).
 * Returns array of { name, url, category }.
 */
async function findAllDocumentFolders(page, meetingUrl) {
  await page.goto(meetingUrl, { waitUntil: 'networkidle', timeout: 30000 });

  const rawFolders = await page.evaluate((base) => {
    const folders = [];
    const links = Array.from(document.querySelectorAll('a'));
    for (const link of links) {
      const text = link.textContent.trim();
      const href = link.getAttribute('href') || '';
      // Must be a specific folder (with an ID), not the root /filepro/documents
      if (href.match(/filepro\/documents\/\d+/)) {
        const url = href.startsWith('http') ? href : `${base}${href}`;
        folders.push({ name: text, url });
      }
    }
    return folders;
  }, CIVICWEB_BASE);

  // Also grab the Agenda PDF link if available
  const agendaUrl = await page.evaluate((base) => {
    const links = Array.from(document.querySelectorAll('a'));
    for (const link of links) {
      const text = link.textContent.trim();
      const href = link.getAttribute('href') || '';
      if (text === 'Agenda Packet' && href.includes('/document/')) {
        return href.startsWith('http') ? href : `${base}${href}`;
      }
    }
    return null;
  }, CIVICWEB_BASE);

  const folders = rawFolders.map(f => ({ ...f, category: categorizeFolder(f.name) }));
  return { folders, agendaUrl };
}

/**
 * Parse a filepro documents page for individual items.
 * For ordinance/resolution folders, uses strict Ord./Res. pattern matching.
 * For other folders, captures all PDF links with a generated ID.
 * Returns array of { ordinance_num, title, doc_type, source_url, current_state }.
 */
async function parseDocumentFolder(page, folderUrl, category = 'ordinance') {
  await page.goto(folderUrl, { waitUntil: 'networkidle', timeout: 30000 });

  return page.evaluate((args) => {
    const { base, category } = args;
    const items = [];
    const links = Array.from(document.querySelectorAll('a'));
    let index = 0;

    for (const link of links) {
      const text = link.textContent.trim();
      const href = link.getAttribute('href') || '';

      if (category === 'ordinance') {
        // Strict matching for ordinances/resolutions
        const ordMatch = text.match(/^(Ord\.|Res\.)\s*(\d{2,4}-\d{1,4})/i);
        if (!ordMatch) continue;

        const prefix = ordMatch[1].toLowerCase();
        const num = ordMatch[2];
        const doc_type = prefix.startsWith('ord') ? 'ordinance' : 'resolution';
        const ordinance_num = `${prefix.startsWith('ord') ? 'Ord' : 'Res'}-${num}`;
        const isWithdrawn = /withdrawn/i.test(text);
        const source_url = href.startsWith('http') ? href : `${base}${href}`;

        items.push({
          ordinance_num,
          title: text.replace(/\s*-\s*Pdf\s*$/i, '').trim(),
          doc_type,
          source_url,
          current_state: isWithdrawn ? 'WITHDRAWN' : 'INTRODUCED'
        });
      } else {
        // Permissive matching for consent, communications, etc.
        // Only grab links that point to filepro preview or document URLs
        if (!href.includes('filepro/') && !href.includes('preview=')) continue;
        if (!text || text.length < 3) continue;

        const source_url = href.startsWith('http') ? href : `${base}${href}`;
        const title = text.replace(/\s*-\s*Pdf\s*$/i, '').trim();
        index++;

        items.push({
          ordinance_num: `${category}-${String(index).padStart(3, '0')}`,
          title,
          doc_type: category,
          source_url,
          current_state: 'PASSED' // consent/communication items are already approved
        });
      }
    }

    return items;
  }, { base: CIVICWEB_BASE, category });
}

/**
 * Parse the Agenda Packet PDF to extract structured notice items
 * (communications, appointments, claims, etc.) that aren't in separate folders.
 * Returns array of items with the same shape as parseDocumentFolder output.
 */
async function parseAgendaPdf(requestContext, agendaUrl, meetingDate) {
  try {
    const response = await requestContext.get(agendaUrl, { timeout: 30000 });
    if (response.status() !== 200) return [];

    const buffer = await response.body();
    if (buffer.length < 1000) return [];

    const parser = new PDFParse({ data: buffer, verbosity: VerbosityLevel.ERRORS });
    await parser.load();
    const result = await parser.getText();
    await parser.destroy();
    const text = result.text || '';

    // Only parse the agenda portion (before ordinance/resolution PDF attachments)
    // The agenda table of contents ends around "ADJOURNMENT" — everything after is attachment PDFs
    const adjIdx = text.indexOf('ADJOURNMENT');
    const agendaText = adjIdx > 0 ? text.slice(0, adjIdx + 100) : text.slice(0, 30000);

    // Split into sections by numbered headers like "6. PETITIONS AND COMMUNICATIONS"
    // Use [A-Z \-&] (no \s) to avoid matching across newlines
    const sections = [];
    const sectionPattern = /^(\d+)\.\s+([A-Z][A-Z \-&]+)/gm;
    let match;
    while ((match = sectionPattern.exec(agendaText)) !== null) {
      sections.push({
        num: parseInt(match[1]),
        name: match[2].trim(),
        startIndex: match.index
      });
    }

    // Define which sections contain notice items we want
    const NOTICE_SECTIONS = {
      'PETITIONS AND COMMUNICATIONS': 'communication',
      'REPORTS OF DIRECTORS': 'communication',
      'CLAIMS': 'claims'
    };

    const items = [];
    const dateSlug = (meetingDate || '').replace(/\s+/g, '-');

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const category = NOTICE_SECTIONS[section.name];
      if (!category) continue;

      // Extract text between this section and the next
      const endIndex = i + 1 < sections.length ? sections[i + 1].startIndex : agendaText.length;
      const sectionText = agendaText.slice(section.startIndex, endIndex);

      // Parse numbered items within the section (e.g., "6.1 Letter dated...")
      // Items start with "N.M " and run until the next "N.M " or section end
      const itemPattern = new RegExp(`(?:^|\\n)${section.num}\\.(\\d+)\\s+(.+?)(?=\\n${section.num}\\.\\d+\\s|\\n\\d+\\.\\s+[A-Z][A-Z]|$)`, 'gs');
      let itemMatch;
      while ((itemMatch = itemPattern.exec(sectionText)) !== null) {
        const itemNum = itemMatch[1];
        const itemText = itemMatch[2].replace(/\s+/g, ' ').trim();
        if (itemText.length < 10) continue;
        if (/^NONE$/i.test(itemText)) continue;

        items.push({
          ordinance_num: `${dateSlug}-${category}-${itemNum}`,
          title: itemText.slice(0, 300),
          doc_type: category,
          source_url: agendaUrl,
          current_state: 'PASSED',
          full_text: itemText
        });
      }
    }

    return items;
  } catch (err) {
    console.warn(`  Failed to parse agenda PDF: ${err.message}`);
    return [];
  }
}

/**
 * Main fetch function: scrapes recent meetings, document folders, and agenda PDFs.
 * @param {number} maxMeetings - how many recent meetings to check (default 2)
 * @returns {Array} parsed agenda items from all sources
 */
async function fetchCivicWeb(maxMeetings = 2) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Step 1: Get list of recent meetings
    const meetings = await fetchMeetingList(page);
    console.log(`Found ${meetings.length} meetings`);

    const allItems = [];

    // Step 2: For each recent meeting, parse document folders + agenda PDF
    for (const meeting of meetings.slice(0, maxMeetings)) {
      console.log(`Checking meeting: ${meeting.title}`);

      const { folders, agendaUrl } = await findAllDocumentFolders(page, meeting.url);
      if (folders.length === 0 && !agendaUrl) {
        console.log(`  No document folders or agenda found, skipping`);
        continue;
      }

      // Parse document folders (ordinances/resolutions)
      for (const folder of folders) {
        console.log(`  Parsing folder: ${folder.name} [${folder.category}]`);
        const items = await parseDocumentFolder(page, folder.url, folder.category);
        console.log(`    Found ${items.length} items`);

        for (const item of items) {
          item.meeting_date = meeting.date || null;
          item.meeting_title = meeting.title;
          item.meeting_url = meeting.url || null;
        }
        allItems.push(...items);
      }

      // Parse agenda PDF for community notices
      if (agendaUrl) {
        console.log(`  Parsing agenda PDF for community notices...`);
        const notices = await parseAgendaPdf(context.request, agendaUrl, meeting.date);
        console.log(`    Found ${notices.length} notice items`);

        for (const item of notices) {
          item.meeting_date = meeting.date || null;
          item.meeting_title = meeting.title;
          item.meeting_url = meeting.url || null;
        }
        allItems.push(...notices);
      }
    }

    // Deduplicate by ordinance_num
    const seen = new Set();
    const deduped = allItems.filter(item => {
      const key = item.ordinance_num;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Step 3: Extract PDF text for ordinances/resolutions only (notices already have text from agenda)
    const needsPdf = deduped.filter(item => !item.full_text);
    console.log(`\nExtracting PDF text for ${needsPdf.length} items (${deduped.length - needsPdf.length} already have text from agenda)...`);
    let extracted = 0;
    for (const item of needsPdf) {
      item.full_text = await extractPdfText(page, context.request, item.source_url);
      if (item.full_text) {
        extracted++;
        console.log(`  ${item.ordinance_num}: ${item.full_text.length} chars extracted`);
      }
    }
    console.log(`Extracted text from ${extracted}/${needsPdf.length} PDFs`);

    return deduped;
  } catch (error) {
    console.error('Error fetching CivicWeb:', error.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { fetchCivicWeb, fetchMeetingList, findAllDocumentFolders, parseDocumentFolder, parseAgendaPdf, extractPdfText };

// Run directly for testing
if (require.main === module) {
  fetchCivicWeb().then(items => {
    console.log(`\nTotal: ${items.length} items:`);
    const byType = {};
    for (const item of items) {
      (byType[item.doc_type] = byType[item.doc_type] || []).push(item);
    }
    for (const [type, typeItems] of Object.entries(byType)) {
      console.log(`\n--- ${type.toUpperCase()} (${typeItems.length}) ---`);
      typeItems.forEach((item, i) => {
        console.log(`  ${i + 1}. ${item.ordinance_num} — ${item.title}`);
        console.log(`     State: ${item.current_state} | Meeting: ${item.meeting_date || 'N/A'}`);
        console.log(`     Full text: ${item.full_text ? item.full_text.slice(0, 100) + '...' : 'N/A'}`);
      });
    }
  });
}
