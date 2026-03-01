require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic.default();

const ANALYSIS_PROMPT = `You are a sharp, straight-talking neighbor who happens to know everything about Jersey City government. You explain local politics the way you'd text a friend — casual, concrete, and real. You use emojis naturally (not excessively) to add tone.

Analyze the following government document for this specific person. Return a JSON object only — no markdown, no preamble.

DOCUMENT:
{ordinance_text}

THIS PERSON'S PROFILE:
Ward: {ward}
Housing: {housing}
Transport: {transport}
Has kids: {has_kids}
Income: {income}
Interests: {interests}

JERSEY CITY WARD MAP:
- Ward A (Greenville): south of Communipaw Ave, east of MLK Dr
- Ward B (West Side): west of Kennedy Blvd, south of Manhattan Ave, including West Side Ave
- Ward C (Journal Square): Journal Square, Bergen Ave, JFK Blvd area
- Ward D (The Heights): north of Manhattan Ave, including Central Ave, Summit Ave, Palisade Ave, Van Wagenen Ave
- Ward E (Historic Downtown): Exchange Place, Grove St, Hamilton Park, waterfront east of JFK Blvd
- Ward F (Bergen-Lafayette): Bergen Ave south of Communipaw, Lafayette neighborhood

Return this exact JSON structure:
{
  "plain_title": "short plain-English title (not the legal name)",
  "what_is_happening": "2 sentences max explaining what this document does in plain English. No jargon.",
  "affected_ward": "<A|B|C|D|E|F|citywide>",
  "impact_category": "<one of: housing | money | transit | schools | safety | environment | development | jobs | government>",
  "personal_impact": "1-2 casual sentences with emojis. Talk directly to THIS person about how this hits THEIR daily life. Be concrete and speculative — estimate real consequences like dollar amounts, noise, commute changes, timeline. Examples of the tone and specificity to aim for: 'Construction crew is coming to your block — expect detours and jackhammers for a few months 🚧🔊', 'Good news for your commute — protected bike lanes mean fewer cars cutting you off on your ride to the PATH 🚲', 'Your landlord has to re-register under new deadlines now. If they miss it, you get more leverage on rent increases 🏠💪', 'City is broke — 28% budget gap means your property taxes could jump $300-500/yr to fill the hole 💸'. Be honest: if it is not in their ward or does not really affect them, say so plainly like 'This is over in Ward D, not your area — probably won\\'t touch your life directly 🤷'.",
  "relevance_score": <integer 1-10>,
  "current_status": "<INTRODUCED|AMENDED|COMMITTEE|VOTED|PASSED|FAILED>",
  "status_context": "one sentence explaining what this status means in plain English, e.g. 'This passed 6-3 at Wednesday's meeting and is now law.'",
  "location": "specific street address or intersection mentioned in the document, e.g. '20 Van Wagenen Ave' or 'Journal Square Plaza'. null if no specific location or if citywide.",
  "next_vote_date": "YYYY-MM-DD or null — only include if the document mentions a specific upcoming vote/hearing date. Do NOT guess or make one up.",
  "action_available": <true|false>
}

Scoring guide:
- 8-10: Directly in this user's ward AND affects their housing, finances, commute, or children
- 5-7: In their ward but indirect, OR citywide and relevant to their interests
- 3-4: Different ward but tangentially relevant to their interests
- 1-2: Different ward and no relevance to their profile

Only return the JSON. No other text.`;

/**
 * Build the analysis prompt with injected data.
 */
function buildPrompt(ordinanceText, profile) {
  return ANALYSIS_PROMPT
    .replace('{ordinance_text}', ordinanceText)
    .replace('{ward}', profile.ward || 'Unknown')
    .replace('{housing}', profile.housing || 'Unknown')
    .replace('{transport}', profile.transport || 'Unknown')
    .replace('{has_kids}', String(profile.has_kids || false))
    .replace('{income}', profile.income || 'Not specified')
    .replace('{interests}', Array.isArray(profile.interests) ? profile.interests.join(', ') : String(profile.interests || ''));
}

/**
 * Analyze an ordinance for a specific user profile using Claude.
 *
 * @param {string} ordinanceText - the full text or title+description of the ordinance
 * @param {Object} profile - { ward, housing, transport, has_kids, interests }
 * @returns {Object} parsed JSON analysis result
 */
async function analyzeOrdinance(ordinanceText, profile, maxRetries = 3) {
  const prompt = buildPrompt(ordinanceText, profile);

  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: prompt }
        ]
      });

      const responseText = message.content[0].text.trim();

  // Parse the JSON response, handling potential markdown code fences
  let jsonStr = responseText;
  const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const result = JSON.parse(jsonStr);

  // Validate required fields
  const requiredFields = ['plain_title', 'what_is_happening', 'affected_ward', 'impact_category', 'personal_impact', 'relevance_score', 'current_status', 'status_context', 'action_available'];
  for (const field of requiredFields) {
    if (!(field in result)) {
      throw new Error(`Missing required field in Claude response: ${field}`);
    }
  }

  // Ensure relevance_score is a number
  result.relevance_score = Number(result.relevance_score);

  return result;
    } catch (err) {
      lastError = err;
      // Retry on rate limit (429) or server errors (5xx)
      const status = err?.status || err?.statusCode;
      if (status === 429 || (status >= 500 && status < 600)) {
        const waitSec = Math.pow(2, attempt + 1) * 5; // 10s, 20s, 40s
        console.log(`      Rate limited, waiting ${waitSec}s before retry ${attempt + 1}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw err; // Non-retryable error
    }
  }
  throw lastError;
}

module.exports = { analyzeOrdinance, buildPrompt };
