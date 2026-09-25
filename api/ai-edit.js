// /api/ai-edit.js — receives { html, selector, instruction, browserId }, calls Gemini to rewrite HTML.
// Uses the new @google/genai SDK (replaces old @google/generative-ai).
// Accepts AQ.-format keys (new Google format) — no prefix validation.
// Free-tier daily limit: 10 edits per browserId per UTC day, tracked in Firestore
// (collection "aiUsage", doc id `${browserId}_${YYYY-MM-DD}`). BYOK edits (Claude/GPT,
// and a user's own Gemini key) never touch this route, so they're never limited here.
const { GoogleGenAI } = require("@google/genai");
const { getDb } = require("../lib/firebase");
const { doc, getDoc, setDoc } = require("firebase/firestore");
const { verifyRequestToken } = require("../lib/admin-firebase");
const ashna = require("../lib/ashna");
const aiProviders = require("../lib/ai-providers");

// SECURITY: GEMINI_API_KEY must be set as a Vercel env var — never hardcoded.
// The previous hardcoded fallback was exposed when the site was mirrored with
// `wget --mirror` and the bundled function source leaked. Now there's NO
// fallback — if the env var is missing, the function returns a clear error.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const FREE_DAILY_LIMIT = 10;

// Block scraper/bot User-Agents at the function level.
function isScraperUa(ua) {
  if (!ua || ua.length < 20) return true;
  const lower = ua.toLowerCase();
  const patterns = ["wget", "curl", "httrack", "scrapy", "python-requests", "python-httpx",
    "python-urllib", "httpclient", "mechanize", "node-fetch", "got/", "axios/",
    "go-http-client", "okhttp", "spider", "crawler", "archive.org", "ahrefsbot",
    "semrush", "bytespider"];
  return patterns.some(p => lower.includes(p));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Block scrapers
  if (isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden." });
  }

  try {
    const { html, selector, instruction, browserId, provider, model } = req.body || {};

    if (!html || !instruction) {
      return res.status(400).json({ error: "html and instruction are required" });
    }

    // --- Ashna provider branch (Pro-only) ---
    if (provider === "ashna") {
      return handleAshnaEdit(req, res, { html, selector, instruction, model });
    }

    // --- OpenCode Zen branch (Pro-only, 50/day per-user cap) ---
    if (provider === "opencode") {
      return handleProProviderEdit(req, res, { html, selector, instruction, model, provider });
    }

    // --- OpenRouter branch (FREE tier, same as Gemini — 10/day browserId limit) ---
    // OpenRouter free models are NOT Pro-gated. They share the same daily limit as Gemini.
    if (provider === "openrouter") {
      return handleOpenRouterEdit(req, res, { html, selector, instruction, model, browserId });
    }

    // --- Existing Gemini flow below (unchanged) ---

    // --- Daily free-tier limit (per browserId, resets at UTC midnight) ---
    // Only CHECK here — we only count it against the quota once Gemini actually
    // succeeds (see the setDoc call further down), so a failed/unavailable-model
    // attempt doesn't burn one of the person's 10 free edits for nothing.
    const today = new Date().toISOString().slice(0, 10);
    const usageId = (browserId || "anonymous") + "_" + today;
    let usageCount = 0;
    let usageDb = null;
    try {
      usageDb = getDb();
      const usageRef = doc(usageDb, "aiUsage", usageId);
      const usageSnap = await getDoc(usageRef);
      usageCount = usageSnap.exists() ? (usageSnap.data().count || 0) : 0;
      if (usageCount >= FREE_DAILY_LIMIT) {
        return res.status(429).json({
          error: `You've used all ${FREE_DAILY_LIMIT} free AI edits for today. Add your own Gemini, Claude, or GPT key in Settings for unlimited edits, or try again tomorrow.`,
          limitReached: true,
        });
      }
    } catch (usageErr) {
      // If Firestore tracking fails for any reason, don't block the edit over it —
      // just skip the limit check for this request.
      console.warn("[ai-edit] Usage check failed (allowing request):", usageErr.message);
    }

    // Only check that the key exists — don't validate prefix format
    if (!GEMINI_API_KEY || GEMINI_API_KEY.length < 10) {
      return res.status(500).json({
        error: "Gemini API key not configured. Set GEMINI_API_KEY in Vercel env vars or hardcode it in api/ai-edit.js."
      });
    }

    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    const prompt = `You are an HTML editor. The user has an HTML document and wants to change a specific part of it.

Here is the complete HTML document:
\`\`\`html
${html}
\`\`\`

The user selected the element matching this CSS selector: "${selector || "body"}"

The user's instruction: "${instruction}"

IMPORTANT INSTRUCTIONS:
1. Apply the requested change to the selected element (or the whole document if no specific element).
2. Return the COMPLETE updated HTML document — from <!DOCTYPE html> to </html>.
3. Do NOT wrap the output in markdown code fences.
4. Do NOT add any explanation, commentary, or text before or after the HTML.
5. Do NOT change any part of the document that the user didn't ask to change.
6. Keep all existing content intact unless the user explicitly asked to change it.

Return ONLY the raw HTML:`;

    // Try models in order — fallback if one is deprecated/unavailable.
    // Verified against Google's official deprecation page as of Sept 2026:
    // - gemini-2.0-flash was FULLY SHUT DOWN June 1, 2026 — removed from this list.
    // - gemini-2.5-flash is GA-stable until Oct 16, 2026 (safe baseline for now).
    // - gemini-flash-latest is an alias that always points to the current-gen Flash
    //   model (now gemini-3.5-flash under the hood as of May 2026).
    // - gemini-3-flash-preview / gemini-3.1-flash-lite added as newer-gen fallbacks
    //   so this doesn't break again when 2.5-flash is eventually shut down.
    const models = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-3-flash-preview", "gemini-3.1-flash-lite"];
    let response = null;
    let lastError = null;
    for (const modelName of models) {
      for (let attempt = 0; attempt < 2; attempt++) { // retry once on 503
        try {
          response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
          });
          break;
        } catch (modelErr) {
          lastError = modelErr;
          const errMsg = (modelErr.message || "").toLowerCase();
          console.warn("[ai-edit] Model " + modelName + " attempt " + (attempt+1) + " failed:", (modelErr.message || "").slice(0, 100));
          // If 503 (overloaded), wait 1s (down from 2s) and retry once
          if (errMsg.includes("503") || errMsg.includes("unavailable") || errMsg.includes("high demand")) {
            if (attempt === 0) { await new Promise(r => setTimeout(r, 1000)); continue; }
          }
          // If model not found (404), skip to next model immediately
          break;
        }
      }
      if (response) break;
    }
    if (!response) {
      let msg = "AI editor is currently unavailable. ";
      if (lastError) {
        const e = (lastError.message || "").toLowerCase();
        if (e.includes("503") || e.includes("unavailable") || e.includes("high demand")) {
          msg = "Gemini is overloaded right now (503). Please wait 1-2 minutes and try again. This is temporary.";
        } else if (e.includes("404") || e.includes("not found") || e.includes("no longer available")) {
          msg = "All Gemini models are deprecated. Check https://ai.google.dev for the latest model name and update api/ai-edit.js.";
        } else if (e.includes("401") || e.includes("api key not valid") || e.includes("unauthenticated")) {
          msg = "Gemini API key authentication failed. Check that GEMINI_API_KEY in Vercel matches exactly what's in Google AI Studio.";
        }
      }
      return res.status(500).json({ error: msg });
    }

    // Only now — a model actually answered — count it against the free daily quota.
    try {
      if (usageDb) {
        const usageRef = doc(usageDb, "aiUsage", usageId);
        await setDoc(usageRef, { count: usageCount + 1, browserId: browserId || "anonymous", date: today }, { merge: true });
      }
    } catch (usageErr) {
      console.warn("[ai-edit] Usage increment failed (edit still applied):", usageErr.message);
    }

    let updatedHtml = response.text;

    // Clean up: remove markdown code fences if Gemini added them
    updatedHtml = updatedHtml.trim();
    if (updatedHtml.startsWith("```html")) {
      updatedHtml = updatedHtml.replace(/^```html\s*/, "").replace(/\s*```$/, "");
    } else if (updatedHtml.startsWith("```")) {
      updatedHtml = updatedHtml.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    // Ensure it starts with <!DOCTYPE html> or <html
    if (!updatedHtml.toLowerCase().startsWith("<!doctype") && !updatedHtml.toLowerCase().startsWith("<html")) {
      const htmlMatch = updatedHtml.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
      if (htmlMatch) updatedHtml = htmlMatch[0];
    }

    return res.status(200).json({ html: updatedHtml });
  } catch (err) {
    console.error("[ai-edit] Error:", err);
    let msg = err.message || "AI edit failed";
    // Auth-related errors — tell user to check their key, not that the format is wrong
    if (msg.includes("401") || msg.includes("API key not valid") || msg.includes("UNAUTHENTICATED") || msg.includes("permission_denied")) {
      msg = "Gemini API key authentication failed. Double-check that GEMINI_API_KEY in Vercel exactly matches what's shown in Google AI Studio — no extra spaces or truncation.";
    }
    return res.status(500).json({ error: msg });
  }
};

// ===== Ashna provider handler (Pro-only) =====
// Reuses the same HTML size limit + fence-stripping conventions as Gemini.
// Differs in: requires a verified Firebase ID token + Pro flag, has its own
// per-user daily cap (50/day by default), uses OpenAI-compatible chat-completions.
async function handleAshnaEdit(req, res, body) {
  // The body fields were already validated by the main handler (html + instruction
  // are present). Re-check here for safety in case handleAshnaEdit is called directly.
  if (!body.html || !body.instruction) {
    return res.status(400).json({ error: "html and instruction are required" });
  }
  // HTML size limit (matches Gemini's 500KB cap)
  if (typeof body.html === "string" && body.html.length > 500_000) {
    return res.status(413).json({ error: "HTML too large (max 500KB)" });
  }
  // Model ID is required for Ashna calls
  if (!body.model || typeof body.model !== "string" || body.model.length > 100) {
    return res.status(400).json({ error: "Valid model ID is required for Ashna" });
  }

  // --- Step 1: Verify the Firebase ID token server-side ---
  // uid is taken from the VERIFIED token — never from the request body.
  // If the token is missing or invalid → 401.
  let decoded;
  try {
    decoded = await verifyRequestToken(req);
  } catch (err) {
    const status = err.status || 401;
    return res.status(status).json({
      error: status === 401
        ? "Sign in to use Ashna models"
        : (err.message || "Authentication required"),
    });
  }
  const uid = decoded.uid;

  // --- Step 2: Require Pro flag in Firestore (same flag Paystack sets) ---
  // Reuses the existing Firestore client SDK init. The user doc is read with
  // the verified uid. If pro !== true → 403, regardless of browserId.
  let userDoc = null;
  try {
    const db = getDb();
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) userDoc = snap.data();
  } catch (e) {
    // Firestore might be down — fail safe (deny rather than accidentally allow)
    console.error("[ai-edit:ashna] Couldn't read user doc:", e.message || e);
    return res.status(500).json({ error: "Couldn't verify account status. Try again." });
  }
  if (!userDoc || userDoc.pro !== true) {
    return res.status(403).json({
      error: "AshnaAI is a Pro feature. Upgrade to Pro to use it.",
      proRequired: true,
    });
  }

  // --- Step 3: Validate the requested model against the cached catalog ---
  // The cached catalog is the intersection of ASHNA_ALLOWED_MODELS ∩ live /models
  // response. A model not in the catalog returns 400 (user error, not provider).
  const isValidModel = await ashna.validateAshnaModel(body.model);
  if (!isValidModel) {
    return res.status(400).json({
      error: "Unknown or unavailable AshnaAI model: " + body.model,
    });
  }

  // --- Step 4: Per-user daily cap (Pro users, 50/day by default) ---
  // Stored in Firestore collection "ashnaUsage", doc id = `${uid}_${YYYY-MM-DD}`,
  // field "count" (number). Counter is incremented ONLY on success — a failed
  // Ashna call doesn't burn the user's quota.
  const today = new Date().toISOString().slice(0, 10);
  const usageId = uid + "_" + today;
  const DAILY_LIMIT = ashna._dailyLimit();
  let usageCount = 0;
  let db = null;
  try {
    db = getDb();
    const usageRef = doc(db, "ashnaUsage", usageId);
    const usageSnap = await getDoc(usageRef);
    usageCount = usageSnap.exists() ? (usageSnap.data().count || 0) : 0;
    if (usageCount >= DAILY_LIMIT) {
      return res.status(429).json({
        error: `You've used all ${DAILY_LIMIT} AshnaAI edits for today. Try again tomorrow.`,
        limitReached: true,
      });
    }
  } catch (e) {
    // If Firestore tracking fails, don't block the request — fail open.
    // (The Pro check above is the real security gate; the cap is just fairness.)
    console.warn("[ai-edit:ashna] Usage check failed (allowing):", e.message || e);
  }

  // --- Step 5: Build the prompt (same content as Gemini's prompt) ---
  const systemPrompt = "You are a precise HTML editor. Return only complete valid HTML.";
  const userPrompt = `You are an HTML editor. The user has an HTML document and wants to change a specific part of it.

Here is the complete HTML document:
\`\`\`html
${body.html}
\`\`\`

The user selected the element matching this CSS selector: "${body.selector || "body"}"

The user's instruction: "${body.instruction}"

IMPORTANT INSTRUCTIONS:
1. Apply the requested change to the selected element (or the whole document if no specific element).
2. Return the COMPLETE updated HTML document — from <!DOCTYPE html> to </html>.
3. Do NOT wrap the output in markdown code fences.
4. Do NOT add any explanation, commentary, or text before or after the HTML.
5. Do NOT change any part of the document that the user didn't ask to change.
6. Keep all existing content intact unless the user explicitly asked to change it.

Return ONLY the raw HTML:`;

  // --- Step 6: Call Ashna with a hard timeout shorter than maxDuration ---
  // Vercel Hobby maxDuration is 60s for this route (set in vercel.json).
  // We use 50s for Ashna so there's buffer to clean up + return the response.
  let ashnaResult;
  try {
    ashnaResult = await ashna.callAshnaChat(body.model, systemPrompt, userPrompt, {
      timeoutMs: 50000,
    });
  } catch (err) {
    // err.status is set by callAshnaChat to 502/503/504/429
    const status = err.status || 502;
    return res.status(status).json({
      error: err.message || "AI provider error",
    });
  }

  // --- Step 7: Strip fences + validate the output is complete HTML ---
  const validated = ashna.validateAndExtractHtml(ashnaResult.text);
  if (!validated.ok) {
    // Don't expose the model's raw output — could contain provider error text
    return res.status(502).json({
      error: "AshnaAI returned an incomplete or invalid HTML response. Try rephrasing your instruction.",
    });
  }

  // --- Step 8: Increment the daily counter (only on success) ---
  try {
    if (db) {
      const usageRef = doc(db, "ashnaUsage", usageId);
      await setDoc(usageRef, {
        count: usageCount + 1,
        uid,
        date: today,
        provider: "ashna",
        model: body.model,
      }, { merge: true });
    }
  } catch (e) {
    // Don't fail the edit over a counter increment
    console.warn("[ai-edit:ashna] Usage increment failed (edit still applied):", e.message || e);
  }

  // --- Success ---
  return res.status(200).json({ html: validated.html });
}

// ===== Pro-only provider handler (OpenCode Zen + AgentRouter) =====
// Same Pro-gating pattern as Ashna:
//   1. Verify Firebase ID token (server-side via Admin SDK)
//   2. Read user doc from Firestore, require pro === true
//   3. Validate model against the static catalog
//   4. Per-user daily cap (50/day, configurable via PROVIDER_DAILY_LIMIT)
//   5. Call provider API with timeout
//   6. Strip fences, validate HTML, return { html }
//   7. Increment counter only on success
const PROVIDER_DAILY_LIMIT = parseInt(process.env.PROVIDER_DAILY_LIMIT || "50", 10) || 50;

async function handleProProviderEdit(req, res, body) {
  if (!body.html || !body.instruction) {
    return res.status(400).json({ error: "html and instruction are required" });
  }
  if (typeof body.html === "string" && body.html.length > 500_000) {
    return res.status(413).json({ error: "HTML too large (max 500KB)" });
  }
  if (!body.model || typeof body.model !== "string" || body.model.length > 200) {
    return res.status(400).json({ error: "Valid model ID is required" });
  }
  if (!body.provider || (body.provider !== "opencode" && body.provider !== "openrouter")) {
    return res.status(400).json({ error: "Provider must be 'opencode' or 'openrouter'" });
  }

  // --- Step 1: Verify the Firebase ID token (server-side) ---
  let decoded;
  try {
    decoded = await verifyRequestToken(req);
  } catch (err) {
    const status = err.status || 401;
    return res.status(status).json({
      error: status === 401
        ? "Sign in to use this AI provider"
        : (err.message || "Authentication required"),
    });
  }
  const uid = decoded.uid;

  // --- Step 2: Require Pro flag in Firestore ---
  let userDoc = null;
  try {
    const db = getDb();
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) userDoc = snap.data();
  } catch (e) {
    console.error("[ai-edit:" + body.provider + "] Couldn't read user doc:", e.message || e);
    return res.status(500).json({ error: "Couldn't verify account status. Try again." });
  }
  if (!userDoc || userDoc.pro !== true) {
    return res.status(403).json({
      error: "This AI provider is a Pro feature. Upgrade to Pro to use it.",
      proRequired: true,
    });
  }

  // --- Step 3: Validate model against the static catalog ---
  const isValidModel = aiProviders.validateModel(body.provider, body.model);
  if (!isValidModel) {
    return res.status(400).json({
      error: "Unknown or unavailable model for " + body.provider + ": " + body.model,
    });
  }

  // --- Step 4: Per-user daily cap (Pro users, 50/day by default) ---
  // Stored in Firestore collection "providerUsage", doc id = `${uid}_${provider}_${date}`
  const today = new Date().toISOString().slice(0, 10);
  const usageId = uid + "_" + body.provider + "_" + today;
  let usageCount = 0;
  let db = null;
  try {
    db = getDb();
    const usageRef = doc(db, "providerUsage", usageId);
    const usageSnap = await getDoc(usageRef);
    usageCount = usageSnap.exists() ? (usageSnap.data().count || 0) : 0;
    if (usageCount >= PROVIDER_DAILY_LIMIT) {
      return res.status(429).json({
        error: `You've used all ${PROVIDER_DAILY_LIMIT} ${body.provider} edits for today. Try again tomorrow.`,
        limitReached: true,
      });
    }
  } catch (e) {
    console.warn("[ai-edit:" + body.provider + "] Usage check failed (allowing):", e.message || e);
  }

  // --- Step 5: Build the prompt (same as Gemini + Ashna) ---
  const systemPrompt = "You are a precise HTML editor. Return only complete valid HTML.";
  const userPrompt = `You are an HTML editor. The user has an HTML document and wants to change a specific part of it.

Here is the complete HTML document:
\`\`\`html
${body.html}
\`\`\`

The user selected the element matching this CSS selector: "${body.selector || "body"}"

The user's instruction: "${body.instruction}"

IMPORTANT INSTRUCTIONS:
1. Apply the requested change to the selected element (or the whole document if no specific element).
2. Return the COMPLETE updated HTML document — from <!DOCTYPE html> to </html>.
3. Do NOT wrap the output in markdown code fences.
4. Do NOT add any explanation, commentary, or text before or after the HTML.
5. Do NOT change any part of the document that the user didn't ask to change.
6. Keep all existing content intact unless the user explicitly asked to change it.

Return ONLY the raw HTML:`;

  // --- Step 6: Call the provider ---
  let result;
  try {
    result = await aiProviders.callProvider(body.provider, body.model, systemPrompt, userPrompt, {
      timeoutMs: 50000,
    });
  } catch (err) {
    const status = err.status || 502;
    return res.status(status).json({ error: err.message || "AI provider error" });
  }

  // --- Step 7: Strip fences + validate HTML ---
  const validated = ashna.validateAndExtractHtml(result.text);
  if (!validated.ok) {
    return res.status(502).json({
      error: "AI provider returned an incomplete or invalid HTML response. Try rephrasing your instruction.",
    });
  }

  // --- Step 8: Increment daily counter (only on success) ---
  try {
    if (db) {
      const usageRef = doc(db, "providerUsage", usageId);
      await setDoc(usageRef, {
        count: usageCount + 1,
        uid,
        provider: body.provider,
        model: body.model,
        date: today,
      }, { merge: true });
    }
  } catch (e) {
    console.warn("[ai-edit:" + body.provider + "] Usage increment failed:", e.message || e);
  }

  return res.status(200).json({ html: validated.html });
}

// ===== OpenRouter handler (FREE tier — not Pro-gated) =====
// Same daily limit as Gemini (10 edits/day per browserId). No token verification needed.
// Validates model against the dynamically fetched free model list.
async function handleOpenRouterEdit(req, res, body) {
  if (!body.html || !body.instruction) {
    return res.status(400).json({ error: "html and instruction are required" });
  }
  if (typeof body.html === "string" && body.html.length > 500_000) {
    return res.status(413).json({ error: "HTML too large (max 500KB)" });
  }
  if (!body.model || typeof body.model !== "string") {
    return res.status(400).json({ error: "model ID is required" });
  }

  // --- Daily free-tier limit (same as Gemini — browserId, 10/day) ---
  const today = new Date().toISOString().slice(0, 10);
  const usageId = (body.browserId || "anonymous") + "_" + today;
  let usageCount = 0;
  let usageDb = null;
  try {
    usageDb = getDb();
    const usageRef = doc(usageDb, "aiUsage", usageId);
    const usageSnap = await getDoc(usageRef);
    usageCount = usageSnap.exists() ? (usageSnap.data().count || 0) : 0;
    if (usageCount >= FREE_DAILY_LIMIT) {
      return res.status(429).json({
        error: `You've used all ${FREE_DAILY_LIMIT} free AI edits for today. Try again tomorrow.`,
        limitReached: true,
      });
    }
  } catch (e) {
    console.warn("[ai-edit:openrouter] Usage check failed (allowing):", e.message);
  }

  // --- Validate model against the dynamic free model list ---
  const isValidModel = await aiProviders.validateModel("openrouter", body.model);
  if (!isValidModel) {
    return res.status(400).json({
      error: "OpenRouter model '" + body.model + "' not found in the free model list. It may have been deprecated — refresh the page to get the latest models.",
    });
  }

  // --- Build the prompt (same as Gemini) ---
  const systemPrompt = "You are a precise HTML editor. Return only complete valid HTML.";
  const userPrompt = `You are an HTML editor. The user has an HTML document and wants to change a specific part of it.

Here is the complete HTML document:
\`\`\`html
${body.html}
\`\`\`

The user selected the element matching this CSS selector: "${body.selector || "body"}"

The user's instruction: "${body.instruction}"

IMPORTANT INSTRUCTIONS:
1. Apply the requested change to the selected element (or the whole document if no specific element).
2. Return the COMPLETE updated HTML document — from <!DOCTYPE html> to </html>.
3. Do NOT wrap the output in markdown code fences.
4. Do NOT add any explanation, commentary, or text before or after the HTML.
5. Do NOT change any part of the document that the user didn't ask to change.
6. Keep all existing content intact unless the user explicitly asked to change it.

Return ONLY the raw HTML:`;

  // --- Call OpenRouter ---
  let result;
  try {
    result = await aiProviders.callProvider("openrouter", body.model, systemPrompt, userPrompt, {
      timeoutMs: 50000,
    });
  } catch (err) {
    const status = err.status || 502;
    return res.status(status).json({ error: err.message || "OpenRouter error" });
  }

  // --- Strip fences + validate HTML ---
  const validated = ashna.validateAndExtractHtml(result.text);
  if (!validated.ok) {
    return res.status(502).json({
      error: "OpenRouter returned an incomplete or invalid HTML response. Try rephrasing your instruction.",
    });
  }

  // --- Increment daily counter (only on success) ---
  try {
    if (usageDb) {
      const usageRef = doc(usageDb, "aiUsage", usageId);
      await setDoc(usageRef, {
        count: usageCount + 1,
        browserId: body.browserId || "anonymous",
        date: today,
        provider: "openrouter",
        model: body.model,
      }, { merge: true });
    }
  } catch (e) {
    console.warn("[ai-edit:openrouter] Usage increment failed:", e.message);
  }

  return res.status(200).json({ html: validated.html });
}
