// ============================================================
//  ai_assist.js  —  AI-Powered Travel Data Entry
//  Google Apps Script (V8 Runtime)
//
//  DEPENDENCIES
//    • Script Property  : GEMINI_API_KEY
//    • Google Sheet     : "Mastervalue"
//    • Column mapping   : [ID, city, spotName, category, notes,
//                          longDescription, openingHours,
//                          bookingRequirement, status, priority,
//                          instagramUrl, mapsUrl, latitude, longitude]
//
//  USAGE
//    Call openAIAssistModal() from any button / menu trigger.
// ============================================================


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CONFIG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const AI_ASSIST_CONFIG = {
  sheetName    : 'Mastervalue',
  geminiModel  : 'gemini-2.0-flash',
  geminiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/',
  propKey      : 'GEMINI_API_KEY',
  modalTitle   : '✦ AI Assist — Add Travel Spot',
  modalWidth   : 540,
  modalHeight  : 500,
};


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   1.  OPEN MODAL  (call this from your + button trigger)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Entry point — wire this to your existing "+" button / onEdit trigger.
 * Example menu binding:
 *   SpreadsheetApp.getUi().createMenu('Travel Tools')
 *     .addItem('+ Add Spot via AI', 'openAIAssistModal')
 *     .addToUi();
 */
function openAIAssistModal() {
  const html = HtmlService
    .createHtmlOutput(_buildModalHTML())
    .setWidth(AI_ASSIST_CONFIG.modalWidth)
    .setHeight(AI_ASSIST_CONFIG.modalHeight);

  SpreadsheetApp
    .getUi()
    .showModalDialog(html, AI_ASSIST_CONFIG.modalTitle);
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   2.  BACKEND — called via google.script.run from the modal
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Main server-side handler.
 * Receives raw user text, sends to Gemini, parses JSON, writes to sheet.
 *
 * @param  {string} userInput  Raw text / links pasted by the user.
 * @return {Object}            { success: boolean, message: string, data?: Object }
 */
function processAIAssistInput(userInput) {
  try {
    if (!userInput || !userInput.trim()) {
      return { success: false, message: 'Input is empty. Please paste some travel data.' };
    }

    // ── Step 1: call Gemini ──────────────────────────────────
    const geminiResponse = _callGemini(userInput.trim());
    if (!geminiResponse.success) {
      return { success: false, message: geminiResponse.error };
    }

    // ── Step 2: parse + validate JSON ───────────────────────
    const spotData = _parseGeminiJSON(geminiResponse.text);
    if (!spotData.success) {
      return { success: false, message: spotData.error };
    }

    // ── Step 3: write to Google Sheet ───────────────────────
    const writeResult = _writeToMastervalue(spotData.data);
    if (!writeResult.success) {
      return { success: false, message: writeResult.error };
    }

    return {
      success : true,
      message : `✓ "${spotData.data.spotName || 'New spot'}" added successfully (Row #${writeResult.newId})`,
      data    : spotData.data,
    };

  } catch (err) {
    console.error('[AI Assist] Unhandled error:', err.message);
    return { success: false, message: 'Unexpected error: ' + err.message };
  }
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   3.  GEMINI API  (UrlFetchApp — key from Script Properties)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Sends userInput to Gemini with the system prompt and returns raw text.
 * @private
 */
function _callGemini(userInput) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(AI_ASSIST_CONFIG.propKey);

  if (!apiKey) {
    return {
      success: false,
      error  : 'GEMINI_API_KEY is not set in Script Properties. ' +
               'Go to Project Settings → Script Properties and add the key.',
    };
  }

  const url = AI_ASSIST_CONFIG.geminiEndpoint
            + AI_ASSIST_CONFIG.geminiModel
            + ':generateContent?key='
            + apiKey;

  const prompt = _buildSystemPrompt(userInput);

  const payload = {
    contents: [
      {
        role : 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature     : 0.2,   // low temperature = deterministic, structured output
      maxOutputTokens : 1024,
      topP            : 0.8,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  const options = {
    method             : 'post',
    contentType        : 'application/json',
    payload            : JSON.stringify(payload),
    muteHttpExceptions : true,
  };

  let response;
  try {
    response = UrlFetchApp.fetch(url, options);
  } catch (fetchErr) {
    return { success: false, error: 'Network error calling Gemini: ' + fetchErr.message };
  }

  const statusCode = response.getResponseCode();
  const body       = response.getContentText();

  if (statusCode !== 200) {
    console.error('[AI Assist] Gemini HTTP ' + statusCode + ': ' + body);
    return {
      success: false,
      error  : 'Gemini API returned HTTP ' + statusCode + '. Check your API key and quota.',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    return { success: false, error: 'Could not parse Gemini API response.' };
  }

  // Extract the text content from the response
  const candidate = parsed?.candidates?.[0];
  if (!candidate) {
    const blockReason = parsed?.promptFeedback?.blockReason;
    return {
      success: false,
      error  : blockReason
        ? 'Gemini blocked the request: ' + blockReason
        : 'Gemini returned no candidates. The input may have been filtered.',
    };
  }

  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) {
    return { success: false, error: 'Gemini response contained no text output.' };
  }

  return { success: true, text: text.trim() };
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   4.  SYSTEM PROMPT BUILDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/** @private */
function _buildSystemPrompt(userInput) {
  return `You are an elite Travel Data Extraction and Research Assistant.

You MUST return only a valid raw JSON object — no markdown, no explanation, no conversational text, no code fences.

TARGET OUTPUT SCHEMA — return this exact structure:
{
  "city": "",
  "spotName": "",
  "category": "",
  "notes": "",
  "longDescription": "",
  "openingHours": "",
  "bookingRequirement": "",
  "status": "",
  "priority": "",
  "instagramUrl": "",
  "mapsUrl": "",
  "latitude": "",
  "longitude": "",
  "ticketUrl": "",
  "parsedQuery": ""
}

FIELD DEFINITIONS:
- ticketUrl: Full URL for purchasing tickets or making a reservation (e.g. Klook, GetYourGuide, official site). Return "" if not applicable or unknown.
- parsedQuery: A clean 3-7 word English keyword phrase that captures the essence of this spot (e.g. "Rooftop cocktail bar Seminyak Bali"). No emojis. Used for search indexing.

CATEGORY OPTIONS (use the closest match):
Restaurant, Cafe, Bar, Hotel, Museum, Gallery, Park, Beach, Market, Shopping, Landmark, Viewpoint, Temple, Church, Mosque, Nature, Adventure, Nightlife, Spa, Entertainment, Hidden Gem, Street Food, Rooftop, Other

STATUS OPTIONS: Pending, Want to Visit, Visited, Booked, Skip

PRIORITY OPTIONS: Normal, High, Medium, Low

LANGUAGE RULE:
If user input is not in English, translate ALL text fields into English before returning JSON.

DATA ENRICHMENT RULES:
- Use Instagram links, video links, or text context to infer missing place details
- Enrich category, description, and location intelligently when possible
- Never hallucinate factual data — if genuinely unknown, return ""
- For Instagram URLs: preserve the original URL in the instagramUrl field
- For Google Maps URLs: preserve in the mapsUrl field if present; otherwise construct https://www.google.com/maps/search/SPOT+NAME+CITY

FALLBACK LOGIC (sparse input):
- If only a city or vague idea is given (e.g. "cute photo spot in Tokyo"):
  • Use city center coordinates for latitude/longitude
  • Use generic Google Maps search link for mapsUrl
  • Fill all unknown structured fields with ""

STRICT RULES:
- Do not return markdown or code fences
- Do not include explanations or phrases like "here is your result"
- Do not fabricate booking info or coordinates
- Return "" for any field that is genuinely unknown
- latitude and longitude must be numeric strings (e.g. "48.8584") or ""

STRICT RULES — DEFAULT VALUES:
- "status": If the input does not explicitly mention a visit status, always return exactly "Pending". Never leave it blank.
- "priority": If the input does not explicitly mention a priority level, always return exactly "Normal". Never leave it blank.

STRICT RULES — MISSING DATA:
- If there is no data available, verifiable, or reasonably inferable for any field (including openingHours, bookingRequirement, instagramUrl, ticketUrl, latitude, longitude), return exactly "" (empty string).
- Do not manufacture dummy text, placeholder sentences, or filler explanations for empty fields. An empty string means the cell must remain completely blank.

STRICT RULES — EMOJI AND SPECIAL CHARACTER STRIPPING:
- The user's input may contain emojis or decorative Unicode symbols.
- Use these to understand the contextual meaning and vibe of the spot, but completely strip ALL emojis and decorative symbols from every text field in the JSON output before returning.
- Every string value in the output must contain only clean, human-readable alphanumeric text and basic punctuation: periods, commas, hyphens, apostrophes, parentheses. No emojis, no Unicode symbols, no special characters of any kind.
- This rule applies to ALL fields without exception: spotName, notes, longDescription, category, parsedQuery, etc.

STRICT FORMATTING FOR openingHours:
- The openingHours value must NOT be a flat, continuous string (e.g. "Mon-Fri 9am-5pm" is forbidden).
- It must be a single string where each day of the week occupies its own line, separated by \n, in this exact format:
Sunday 9:00 AM to 5:00 PM\nMonday 8:30 AM to 6:00 PM\nTuesday 10:00 AM to 7:00 PM\nWednesday 9:00 AM to 5:30 PM\nThursday 8:00 AM to 4:00 PM\nFriday 11:00 AM to 9:00 PM\nSaturday 10:00 AM to 6:00 PM
- Always list days in order: Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday.
- If hours for a specific day are unknown or cannot be safely inferred, either omit that day's line entirely or write it as: Monday Closed
- If hours are completely unknown for the place, return "" for openingHours.
- Never use ranges like "Mon-Fri", abbreviations, or inline formatting. Each day must be on its own line.

OUTPUT STYLE RULES:
- longDescription: 2-3 sentences, engaging, written for a traveler audience. No emojis.
- notes: 1 short practical sentence (e.g. "Best visited at sunset. Cash only."). No emojis.
- parsedQuery: 3-7 clean English keywords summarizing the spot. No emojis, no punctuation other than spaces and hyphens.
- All other fields must remain structured and clean.

USER INPUT:
${userInput}`;
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   5.  JSON PARSER + VALIDATOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const _REQUIRED_KEYS = [
  'city', 'spotName', 'category', 'notes', 'longDescription',
  'openingHours', 'bookingRequirement', 'status', 'priority',
  'instagramUrl', 'mapsUrl', 'latitude', 'longitude',
  'ticketUrl', 'parsedQuery',
];

/** @private */
function _parseGeminiJSON(rawText) {
  // Strip accidental markdown fences Gemini might sneak in despite instructions
  let cleaned = rawText
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/,           '')
    .trim();

  // Attempt to extract JSON object if there's surrounding text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];

  let data;
  try {
    data = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('[AI Assist] JSON parse error. Raw text:\n', rawText);
    return {
      success: false,
      error  : 'Could not parse Gemini output as JSON. Raw response: ' + rawText.substring(0, 200),
    };
  }

  // Ensure all expected keys exist (fill missing ones with "")
  _REQUIRED_KEYS.forEach(key => {
    if (!(key in data) || data[key] === null || data[key] === undefined) {
      data[key] = '';
    }
    // Coerce all values to strings
    data[key] = String(data[key]).trim();
  });

  return { success: true, data };
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   6.  GOOGLE SHEETS WRITE LOGIC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Finds or creates the Mastervalue sheet, auto-increments ID, appends row.
 * @private
 */
function _writeToMastervalue(data) {
  let sheet;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    sheet = ss.getSheetByName(AI_ASSIST_CONFIG.sheetName);

    if (!sheet) {
      return {
        success: false,
        error  : `Sheet "${AI_ASSIST_CONFIG.sheetName}" not found. ` +
                 'Please create it or check the sheet name in AI_ASSIST_CONFIG.',
      };
    }
  } catch (sheetErr) {
    return { success: false, error: 'Could not access spreadsheet: ' + sheetErr.message };
  }

  // ── Auto-increment ID from Column A ────────────────────────
  const lastRow  = sheet.getLastRow();
  let   newId    = 1;

  if (lastRow >= 2) {
    // Read all values in column A (skip header row 1)
    const colAValues = sheet
      .getRange(2, 1, lastRow - 1, 1)
      .getValues()
      .flat()
      .filter(v => v !== '' && v !== null && !isNaN(Number(v)))
      .map(v => Number(v));

    if (colAValues.length > 0) {
      newId = Math.max(...colAValues) + 1;
    }
  }

  // ── Build row array — must match MasterVault column order A-P ─
  // A=ID, B=City, C=Spot Name, D=Category, E=Notes,
  // F=Long Description, G=Opening Hours, H=Booking Requirement,
  // I=Status, J=Priority, K=Instagram URL, L=Maps URL,
  // M=Latitude, N=Longitude, O=Ticket URL, P=Parsed Query
  const newRow = [
    newId,
    data.city,
    data.spotName,
    data.category,
    data.notes,
    data.longDescription,
    data.openingHours,
    data.bookingRequirement,
    data.status,
    data.priority,
    data.instagramUrl,
    data.mapsUrl,
    data.latitude,
    data.longitude,
    data.ticketUrl,
    data.parsedQuery,
  ];

  try {
    sheet.appendRow(newRow);
    console.log('[AI Assist] Row appended — ID:', newId, '| Spot:', data.spotName);
  } catch (appendErr) {
    return { success: false, error: 'Failed to write to sheet: ' + appendErr.message };
  }

  return { success: true, newId };
}


/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   7.  MODAL HTML  (returned as string to HtmlService)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/** @private */
function _buildModalHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Assist</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:       #0f1117;
    --surface:  #181c27;
    --border:   rgba(99,102,241,0.18);
    --accent:   #7c3aed;
    --accent2:  #db2777;
    --text:     #e2e8f0;
    --muted:    #64748b;
    --success:  #22c55e;
    --error:    #f87171;
    --radius:   14px;
  }

  html, body {
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    font-size: 13px;
  }

  body {
    display: flex;
    flex-direction: column;
    padding: 20px;
    gap: 14px;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .header-icon {
    width: 32px; height: 32px;
    background: linear-gradient(135deg, rgba(124,58,237,0.25), rgba(219,39,119,0.15));
    border: 1px solid rgba(124,58,237,0.35);
    border-radius: 9px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
  }

  .header-text h2 {
    font-size: 14px;
    font-weight: 800;
    background: linear-gradient(90deg, #a78bfa, #f472b6);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: -0.3px;
  }

  .header-text p {
    font-size: 10px;
    color: var(--muted);
    margin-top: 1px;
  }

  /* ── Divider ── */
  hr {
    border: none;
    border-top: 1px solid rgba(99,102,241,0.12);
  }

  /* ── Textarea ── */
  .textarea-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 6px;
  }

  textarea {
    width: 100%;
    flex: 1;
    min-height: 190px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 12.5px;
    line-height: 1.65;
    padding: 12px 14px;
    resize: none;
    outline: none;
    transition: border-color 0.2s;
    font-family: inherit;
  }

  textarea::placeholder { color: #334155; }

  textarea:focus {
    border-color: rgba(124,58,237,0.55);
    box-shadow: 0 0 0 3px rgba(124,58,237,0.09);
  }

  /* ── Submit button ── */
  .submit-btn {
    width: 100%;
    padding: 11px 0;
    background: linear-gradient(to right, #7c3aed, #db2777);
    color: #fff;
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.04em;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    transition: opacity 0.18s, transform 0.1s;
    -webkit-tap-highlight-color: transparent;
  }

  .submit-btn:hover  { opacity: 0.9; }
  .submit-btn:active { transform: scale(0.98); opacity: 0.85; }

  .submit-btn:disabled {
    background: rgba(30,41,59,0.8);
    color: #334155;
    cursor: not-allowed;
    transform: none;
  }

  /* ── Spinner ── */
  .spinner {
    width: 14px; height: 14px;
    border: 2px solid rgba(255,255,255,0.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    display: none;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Status banner ── */
  .status-banner {
    border-radius: 10px;
    padding: 10px 13px;
    font-size: 12px;
    font-weight: 600;
    display: none;
    align-items: flex-start;
    gap: 8px;
    line-height: 1.5;
  }

  .status-banner.success {
    display: flex;
    background: rgba(34,197,94,0.08);
    border: 1px solid rgba(34,197,94,0.22);
    color: #86efac;
  }

  .status-banner.error {
    display: flex;
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.22);
    color: #fca5a5;
  }

  .status-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }

  /* ── Disclaimer ── */
  .disclaimer {
    font-size: 10px;
    color: var(--muted);
    text-align: center;
    opacity: 0.7;
  }

  .disclaimer span {
    color: #7c3aed;
    font-weight: 600;
  }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-icon">✦</div>
  <div class="header-text">
    <h2>AI Assist Smart Entry</h2>
    <p>Paste links, notes, or text — Gemini handles the rest</p>
  </div>
</div>

<hr>

<!-- Textarea -->
<div>
  <div class="textarea-label">Your travel data</div>
  <textarea
    id="userInput"
    placeholder="Paste anything here — Instagram links, Google Maps URLs, video links, or just describe a place.

Examples:
• https://www.instagram.com/p/abc123
• Eiffel Tower, Paris — must visit at sunset, €25 entry
• A cute hidden café near Shinjuku station in Tokyo
• Mixed: 'Rooftop bar in Bali 🌅 https://maps.app.goo.gl/xyz'"
  ></textarea>
</div>

<!-- Status Banner -->
<div id="statusBanner" class="status-banner">
  <span class="status-icon" id="statusIcon"></span>
  <span id="statusText"></span>
</div>

<!-- Submit Button -->
<button class="submit-btn" id="submitBtn" onclick="handleSubmit()">
  <span id="btnSpinner" class="spinner"></span>
  <span id="btnIcon">✦</span>
  <span id="btnLabel">Submit</span>
</button>

<!-- Disclaimer -->
<p class="disclaimer">Data entry powered by <span>Gemini AI Assistant</span></p>


<script>
  var _isProcessing = false;

  function handleSubmit() {
    if (_isProcessing) return;

    var input = document.getElementById('userInput').value.trim();
    if (!input) {
      showStatus('error', '⚠', 'Please paste some travel data before submitting.');
      return;
    }

    setLoading(true);
    clearStatus();

    google.script.run
      .withSuccessHandler(onSuccess)
      .withFailureHandler(onFailure)
      .processAIAssistInput(input);
  }

  function onSuccess(result) {
    setLoading(false);
    if (result && result.success) {
      showStatus('success', '✓', result.message || 'Spot added successfully!');
      document.getElementById('userInput').value = '';
      // Auto-close after 2.8 s on success
      setTimeout(function() { google.script.host.close(); }, 2800);
    } else {
      var msg = (result && result.message) ? result.message : 'Something went wrong. Please try again.';
      showStatus('error', '✕', msg);
    }
  }

  function onFailure(err) {
    setLoading(false);
    var msg = err && err.message ? err.message : String(err);
    showStatus('error', '✕', 'Server error: ' + msg);
  }

  function setLoading(loading) {
    _isProcessing = loading;
    var btn     = document.getElementById('submitBtn');
    var spinner = document.getElementById('btnSpinner');
    var icon    = document.getElementById('btnIcon');
    var label   = document.getElementById('btnLabel');

    btn.disabled        = loading;
    spinner.style.display = loading ? 'block' : 'none';
    icon.style.display    = loading ? 'none'  : 'inline';
    label.textContent     = loading ? 'Processing…' : 'Submit';
  }

  function showStatus(type, icon, text) {
    var banner = document.getElementById('statusBanner');
    banner.className = 'status-banner ' + type;
    document.getElementById('statusIcon').textContent = icon;
    document.getElementById('statusText').textContent = text;
  }

  function clearStatus() {
    var banner = document.getElementById('statusBanner');
    banner.className = 'status-banner';
    banner.style.display = 'none';
  }

  // Allow Ctrl+Enter / Cmd+Enter to submit
  document.getElementById('userInput').addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSubmit();
  });
</script>
</body>
</html>`;
}
