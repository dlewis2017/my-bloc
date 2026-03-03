const { PDFParse, VerbosityLevel } = require('pdf-parse');

const JC_DATA_BASE = 'https://data.jerseycitynj.gov/api/explore/v2.1/catalog/datasets';

const DATASETS = [
  { id: 'planning-board-agendas-2026', board: 'Planning Board' },
  { id: 'zb-agendas-2026', board: 'Zoning Board' }
];

const MAX_PDF_TEXT_LENGTH = 30000;

/**
 * Fetch the list of PDF attachments from a JC Open Data dataset.
 * Returns array of { id, title, url, board }.
 */
async function fetchAttachmentList(datasetId, board) {
  const url = `${JC_DATA_BASE}/${datasetId}/attachments`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  Failed to fetch ${board} attachments: HTTP ${res.status}`);
    return [];
  }
  const json = await res.json();
  return (json.attachments || []).map(a => ({
    id: a.metas.id,
    title: a.metas.title,
    url: a.metas.url,
    board
  }));
}

/**
 * Extract meeting date from PDF attachment ID.
 * e.g. "05_march_10_2026_mtg_pdf" → { date: "March 10, 2026", isoDate: "2026-03-10" }
 */
function parseDateFromId(attachmentId) {
  // Planning Board: "05_march_10_2026_mtg_pdf"
  // Zoning Board: "3_march_5th_agn_pdf" (no year in filename — default to current year)
  const match = attachmentId.match(/^\d+_([a-z]+)_(\d+)(?:st|nd|rd|th)?_(\d{4})?/);
  if (!match) return { date: null, isoDate: null };

  const monthName = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const day = match[2];
  const year = match[3] || new Date().getFullYear().toString();

  const monthIndex = new Date(`${monthName} 1, 2000`).getMonth();
  const isoDate = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;

  return { date: `${monthName} ${day}, ${year}`, isoDate };
}

/**
 * Download a PDF attachment and extract its text.
 */
async function downloadAndParsePdf(attachmentUrl) {
  const res = await fetch(attachmentUrl, { redirect: 'follow' });
  if (!res.ok) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 500) return null;

  const parser = new PDFParse({ data: buffer, verbosity: VerbosityLevel.ERRORS });
  await parser.load();
  const result = await parser.getText();
  await parser.destroy();

  const text = result.text || '';
  return text.slice(0, MAX_PDF_TEXT_LENGTH);
}

/**
 * Parse individual cases from Planning Board / Zoning Board PDF text.
 * Returns array of case objects.
 */
function parseCases(pdfText) {
  // Normalize unicode dashes (en-dash, em-dash) to regular hyphens
  const normalizedText = pdfText.replace(/[\u2013\u2014]/g, '-');

  // Split by case boundaries: "Case:" or "Case No:" after optional prefix like "a." or "9."
  const casePattern = /(?:^|\n)\s*(?:[\da-z]+\.\s+)?Case(?:\s*No)?[:\s]+\s*([PZ]?[\d][\w-]*)/gi;
  const boundaries = [];
  let match;
  while ((match = casePattern.exec(normalizedText)) !== null) {
    boundaries.push({ index: match.index, caseNum: match[1].trim() });
  }

  if (boundaries.length === 0) return [];

  const cases = [];
  const caseMap = new Map(); // case number → index in cases array (for merging duplicates)

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].index;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index : normalizedText.length;
    const block = normalizedText.slice(start, end).trim();
    let caseNum = boundaries[i].caseNum;

    // Normalize case number: add P prefix if missing and it looks like a planning case
    if (/^\d{4}-\d{3,4}$/.test(caseNum)) {
      caseNum = 'P' + caseNum;
    }

    // Extract fields from the block
    const forMatch = block.match(/\bFor:\s*(.+)/i);
    const addressMatch = block.match(/\bAddress:\s*(.+)/i);
    const wardMatch = block.match(/\bWard:\s*([A-F])\b/i);
    const zoneMatch = block.match(/\bZone:\s*(.+)/i);
    const applicantMatch = block.match(/\bApplicant:\s*(.+)/i);
    const descMatch = block.match(/\bDescription:\s*([\s\S]+?)(?=\n\s*(?:Variances:|'[cd]' Variances:|CARRIED|-- \d|$))/i);
    const statusMatch = block.match(/\b(CARRIED\s+(?:TO|FROM)\b[\s\S]*?)$/i);

    const forText = forMatch ? forMatch[1].trim() : null;
    const address = addressMatch ? addressMatch[1].replace(/\s*Ward:.*$/i, '').trim() : null;
    const ward = wardMatch ? wardMatch[1].toUpperCase() : null;
    const zone = zoneMatch ? zoneMatch[1].trim() : null;
    const applicant = applicantMatch ? applicantMatch[1].trim() : null;
    const description = descMatch ? descMatch[1].replace(/\s+/g, ' ').trim() : null;

    // Determine current state from status line
    let currentState = 'PENDING';
    if (statusMatch) {
      const statusText = statusMatch[1].toUpperCase();
      if (statusText.includes('CARRIED TO')) currentState = 'CARRIED';
      else if (statusText.includes('CARRIED FROM')) currentState = 'CONTINUED';
    }

    // Build title: "For — Address" or just "For" or case number
    const titleParts = [];
    if (forText) titleParts.push(forText);
    if (address) titleParts.push(address);
    const title = titleParts.length > 0
      ? titleParts.join(' — ')
      : `Planning case ${caseNum}`;

    // Use case number + address as dedup key (some agendas reuse case numbers for different items)
    const dedupKey = address ? `${caseNum}@${address}` : caseNum;

    // If we've seen this case before, merge in any new fields (adjournment entries
    // often lack ward/zone/description, but the full entry has them)
    if (caseMap.has(dedupKey)) {
      const existing = cases[caseMap.get(dedupKey)];
      if (!existing.ward && ward) existing.ward = ward;
      if (!existing.zone && zone) existing.zone = zone;
      if (!existing.description && description) existing.description = description;
      if (!existing.applicant && applicant) existing.applicant = applicant;
      if (existing.full_text.length < block.length) existing.full_text = block.slice(0, 3000);
      continue;
    }
    // Also check by case number alone for merging adjournment stubs
    if (caseMap.has(caseNum) && !address) {
      continue; // Skip stub entries without an address if we already have a full entry
    }

    caseMap.set(dedupKey, cases.length);
    if (address) caseMap.set(caseNum, cases.length); // Also index by bare case number
    cases.push({
      ordinance_num: caseNum,
      title,
      doc_type: 'planning',
      source_url: null, // set by caller
      current_state: currentState,
      full_text: block.slice(0, 3000),
      address,
      ward,
      zone,
      applicant,
      description
    });
  }

  return cases;
}

/**
 * Fetch Planning Board and Zoning Board agendas from JC Open Data portal.
 * Downloads PDFs, parses cases, returns items in the standard pipeline format.
 *
 * @param {number} maxAgendas - how many recent agendas to process per board (default 2)
 * @returns {Array} parsed cases from all boards
 */
async function fetchPlanningBoard(maxAgendas = 2) {
  const allItems = [];

  for (const dataset of DATASETS) {
    console.log(`Fetching ${dataset.board} agendas...`);

    let attachments;
    try {
      attachments = await fetchAttachmentList(dataset.id, dataset.board);
    } catch (err) {
      console.warn(`  Failed to fetch ${dataset.board}: ${err.message}`);
      continue;
    }

    if (!attachments.length) {
      console.log(`  No attachments found for ${dataset.board}`);
      continue;
    }

    console.log(`  Found ${attachments.length} agendas`);

    // Process most recent agendas (they're listed in order by filename)
    const recent = attachments.slice(-maxAgendas);

    for (const attachment of recent) {
      const { date, isoDate } = parseDateFromId(attachment.id);
      console.log(`  Processing: ${attachment.title} (${date || 'unknown date'})`);

      let pdfText;
      try {
        pdfText = await downloadAndParsePdf(attachment.url);
      } catch (err) {
        console.warn(`    Failed to download PDF: ${err.message}`);
        continue;
      }

      if (!pdfText || pdfText.length < 100) {
        console.warn(`    PDF text too short, skipping`);
        continue;
      }

      const cases = parseCases(pdfText);
      console.log(`    Parsed ${cases.length} cases`);

      for (const item of cases) {
        item.source_url = attachment.url;
        item.meeting_date = date || null;
        item.meeting_title = `${dataset.board} - ${date || attachment.title}`;
        item.meeting_url = attachment.url;
      }

      allItems.push(...cases);
    }
  }

  // Deduplicate by case number (same case can appear across meetings)
  const seen = new Set();
  const deduped = allItems.filter(item => {
    if (seen.has(item.ordinance_num)) return false;
    seen.add(item.ordinance_num);
    return true;
  });

  console.log(`\nPlanning/Zoning total: ${deduped.length} unique cases`);
  return deduped;
}

module.exports = { fetchPlanningBoard, fetchAttachmentList, downloadAndParsePdf, parseCases, parseDateFromId };

// Run directly for testing
if (require.main === module) {
  fetchPlanningBoard().then(items => {
    console.log(`\nTotal: ${items.length} cases:`);
    for (const item of items) {
      console.log(`  ${item.ordinance_num} — ${item.title}`);
      console.log(`    Ward: ${item.ward || 'N/A'} | Zone: ${item.zone || 'N/A'} | State: ${item.current_state}`);
      console.log(`    Address: ${item.address || 'N/A'}`);
      if (item.description) console.log(`    Desc: ${item.description.slice(0, 120)}...`);
    }
  }).catch(err => {
    console.error('Failed:', err);
    process.exit(1);
  });
}
