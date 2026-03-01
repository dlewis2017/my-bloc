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
 * For a given meeting page, find the ordinances/resolutions document folder link.
 * Returns the filepro documents URL, or null if not found.
 */
async function findDocumentFolderUrl(page, meetingUrl) {
  await page.goto(meetingUrl, { waitUntil: 'networkidle', timeout: 30000 });

  return page.evaluate((base) => {
    // Look for the "ORDINANCES - RESOLUTIONS" link
    const links = Array.from(document.querySelectorAll('a'));
    for (const link of links) {
      const text = link.textContent.trim().toUpperCase();
      const href = link.getAttribute('href') || '';
      if (text.includes('ORDINANCES') || text.includes('RESOLUTIONS')) {
        if (href.includes('filepro/documents')) {
          return href.startsWith('http') ? href : `${base}${href}`;
        }
      }
    }
    return null;
  }, CIVICWEB_BASE);
}

/**
 * Parse the filepro documents page for individual ordinance/resolution items.
 * Returns array of { ordinance_num, doc_type, source_url, current_state }.
 */
async function parseDocumentFolder(page, folderUrl) {
  await page.goto(folderUrl, { waitUntil: 'networkidle', timeout: 30000 });

  return page.evaluate((base) => {
    const items = [];
    const links = Array.from(document.querySelectorAll('a'));

    for (const link of links) {
      const text = link.textContent.trim();
      const href = link.getAttribute('href') || '';

      // Match patterns like "Ord. 26-007 - Pdf" or "Res. 26-067 - Pdf" or "Res. 26-061 - Withdrawn - Pdf"
      const ordMatch = text.match(/^(Ord\.|Res\.)\s*(\d{2,4}-\d{1,4})/i);
      if (!ordMatch) continue;

      const prefix = ordMatch[1].toLowerCase();
      const num = ordMatch[2];
      const doc_type = prefix.startsWith('ord') ? 'ordinance' : 'resolution';
      const ordinance_num = `${prefix.startsWith('ord') ? 'Ord' : 'Res'}-${num}`;

      // Check if withdrawn is in the link text
      const isWithdrawn = /withdrawn/i.test(text);

      const source_url = href.startsWith('http') ? href : `${base}${href}`;

      items.push({
        ordinance_num,
        title: text.replace(/\s*-\s*Pdf\s*$/i, '').trim(),
        doc_type,
        source_url,
        current_state: isWithdrawn ? 'WITHDRAWN' : 'INTRODUCED'
      });
    }

    return items;
  }, CIVICWEB_BASE);
}

/**
 * Main fetch function: scrapes recent meetings and their ordinances/resolutions.
 * @param {number} maxMeetings - how many recent meetings to check (default 2)
 * @returns {Array} parsed agenda items
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

    // Step 2: For each recent meeting, find and parse the document folder
    for (const meeting of meetings.slice(0, maxMeetings)) {
      console.log(`Checking meeting: ${meeting.title}`);

      const folderUrl = await findDocumentFolderUrl(page, meeting.url);
      if (!folderUrl) {
        console.log(`  No document folder found, skipping`);
        continue;
      }

      console.log(`  Found document folder: ${folderUrl}`);
      const items = await parseDocumentFolder(page, folderUrl);
      console.log(`  Found ${items.length} items`);

      // Attach meeting info to each item
      for (const item of items) {
        item.meeting_date = meeting.date || null;
        item.meeting_title = meeting.title;
        item.meeting_url = meeting.url || null;
      }

      allItems.push(...items);
    }

    // Deduplicate by ordinance_num
    const seen = new Set();
    const deduped = allItems.filter(item => {
      const key = item.ordinance_num;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Step 3: Extract PDF text for each item
    console.log(`\nExtracting PDF text for ${deduped.length} items...`);
    let extracted = 0;
    for (const item of deduped) {
      item.full_text = await extractPdfText(page, context.request, item.source_url);
      if (item.full_text) {
        extracted++;
        console.log(`  ${item.ordinance_num}: ${item.full_text.length} chars extracted`);
      }
    }
    console.log(`Extracted text from ${extracted}/${deduped.length} PDFs`);

    return deduped;
  } catch (error) {
    console.error('Error fetching CivicWeb:', error.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { fetchCivicWeb, fetchMeetingList, findDocumentFolderUrl, parseDocumentFolder, extractPdfText };

// Run directly for testing
if (require.main === module) {
  fetchCivicWeb().then(items => {
    console.log(`\nTotal: ${items.length} items:`);
    items.forEach((item, i) => {
      console.log(`\n${i + 1}. [${item.doc_type}] ${item.ordinance_num} — ${item.title}`);
      console.log(`   State: ${item.current_state}`);
      console.log(`   Meeting: ${item.meeting_date || 'N/A'}`);
      console.log(`   Full text: ${item.full_text ? item.full_text.slice(0, 100) + '...' : 'N/A'}`);
    });
  });
}
