require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic.default();

const ANALYSIS_PROMPT = `You are a civic intelligence assistant for Jersey City, NJ residents.

Analyze the following government document and user profile. Return a JSON object only — no markdown, no preamble.

DOCUMENT:
{ordinance_text}

USER PROFILE:
Ward: {ward}
Housing: {housing}
Transport: {transport}
Has kids: {has_kids}
Interests: {interests}

Return this exact JSON structure:
{
  "plain_title": "short plain-English title (not the legal name)",
  "what_is_happening": "2 sentences max explaining what this document does",
  "personal_impact": "1-2 sentences explaining how this specifically affects THIS user based on their profile. Be direct and concrete.",
  "relevance_score": <integer 1-10>,
  "current_status": "<INTRODUCED|AMENDED|COMMITTEE|VOTED|PASSED|FAILED>",
  "status_context": "one sentence explaining what this status means in plain English, e.g. 'This passed 6-3 at Wednesday's meeting and is now law.'",
  "action_available": <true|false>
}

Scoring guide:
- 8-10: Directly affects this user's housing, finances, commute, or children
- 5-7: Relevant to their ward or interests but indirect impact
- 1-4: Citywide background info, low personal relevance

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
    .replace('{interests}', Array.isArray(profile.interests) ? profile.interests.join(', ') : String(profile.interests || ''));
}

/**
 * Analyze an ordinance for a specific user profile using Claude.
 *
 * @param {string} ordinanceText - the full text or title+description of the ordinance
 * @param {Object} profile - { ward, housing, transport, has_kids, interests }
 * @returns {Object} parsed JSON analysis result
 */
async function analyzeOrdinance(ordinanceText, profile) {
  const prompt = buildPrompt(ordinanceText, profile);

  const message = await client.messages.create({
    model: 'claude-opus-4-20250514',
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
  const requiredFields = ['plain_title', 'what_is_happening', 'personal_impact', 'relevance_score', 'current_status', 'status_context', 'action_available'];
  for (const field of requiredFields) {
    if (!(field in result)) {
      throw new Error(`Missing required field in Claude response: ${field}`);
    }
  }

  // Ensure relevance_score is a number
  result.relevance_score = Number(result.relevance_score);

  return result;
}

module.exports = { analyzeOrdinance, buildPrompt };
