// /api/ai-edit.js — receives { html, selector, instruction, browserId }, calls Gemini to rewrite HTML.
// Uses the new @google/genai SDK (replaces old @google/generative-ai).
// Accepts AQ.-format keys (new Google format) — no prefix validation.
// Free-tier daily limit: 50 edits per browserId PER PROVIDER per UTC day.
// Each provider (gemini, openrouter) has its own independent 50/day counter
// so using one doesn't burn the other's quota. Tracked in Firestore
// (collection "aiUsage", doc id `${browserId}_${provider}_${YYYY-MM-DD}`).
// BYOK edits (Claude/GPT, and a user's own Gemini key) never touch this route.
const { GoogleGenAI } = require("@google/genai");
const { getDb } = require("../lib/firebase");
const { doc, getDoc, setDoc } = require("firebase/firestore");
const { verifyRequestToken } = require("../lib/admin-firebase");
const aiProviders = require("../lib/ai-providers");

// ===== HTML validation helper (was in lib/ashna.js — now inline since AshnaAI was removed) =====
// Strips markdown code fences, validates the result is complete HTML.
function stripCodeFences(text) {
  if (!text) return "";
  let t = String(text).trim();
  if (t.startsWith("```html")) {
    t = t.replace(/^```html\s*/, "").replace(/\s*```$/, "");
  } else if (t.startsWith("```")) {
    t = t.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  return t.trim();
}

function validateAndExtractHtml(text) {
  if (!text) return { ok: false };
  let t = stripCodeFences(text);
  if (!t) return { ok: false };
  const lower = t.toLowerCase();
  if (!lower.includes("<!doctype") && !lower.startsWith("<html")) {
    const m = t.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
    if (m) {
      t = m[0];
    } else {
      return { ok: false };
    }
  }
  if (!/<\/html>\s*$/i.test(t)) {
    return { ok: false };
  }
  return { ok: true, html: t };
}

// SECURITY: GEMINI_API_KEY must be set as a Vercel env var — never hardcoded.
// The previous hardcoded fallback was exposed when the site was mirrored with
// `wget --mirror` and the bundled function source leaked. Now there's NO
// fallback — if the env var is missing, the function returns a clear error.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const FREE_DAILY_LIMIT = 50;  // per provider per browserId per UTC day

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

// Phase 3: renamed from `module.exports` to a named function so the
// streaming-aware handler below can call it as a fallback.
async function handleAiEditOriginal(req, res) {
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

    // --- OpenRouter branch (FREE tier, same as Gemini — 50/day browserId limit) ---
    // OpenRouter free models are NOT Pro-gated. They share the same daily limit as Gemini.
    if (provider === "openrouter") {
      return handleOpenRouterEdit(req, res, { html, selector, instruction, model, browserId });
    }

    // --- Existing Gemini flow below (unchanged) ---

    // --- Daily free-tier limit (per browserId PER PROVIDER, resets at UTC midnight) ---
    // Each provider (gemini, openrouter) gets its own 50/day counter so using
    // one doesn't burn the other's quota. Only CHECK here — we only count it
    // against the quota once Gemini actually succeeds (see the setDoc call further
    // down), so a failed/unavailable-model attempt doesn't burn one of the
    // person's free edits for nothing.
    const today = new Date().toISOString().slice(0, 10);
    const usageId = (browserId || "anonymous") + "_gemini_" + today;
    let usageCount = 0;
    let usageDb = null;
    try {
      usageDb = getDb();
      const usageRef = doc(usageDb, "aiUsage", usageId);
      const usageSnap = await getDoc(usageRef);
      usageCount = usageSnap.exists() ? (usageSnap.data().count || 0) : 0;
      if (usageCount >= FREE_DAILY_LIMIT) {
        return res.status(429).json({
          error: `You've used all ${FREE_DAILY_LIMIT} free Gemini edits for today. Try the OpenRouter model from the dropdown (also free), add your own key in Settings, or try again tomorrow.`,
          limitReached: true,
          provider: "gemini",
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

    // BUG 3 FIX: response.text can be null/undefined if the Gemini SDK returns
    // an empty response object. Add a null check before calling .trim() / .replace().
    let updatedHtml = response && response.text ? response.text : "";
    if (!updatedHtml || typeof updatedHtml !== "string") {
      return res.status(502).json({ error: "AI returned an empty response. Try again." });
    }

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

  // --- Daily free-tier limit (per browserId PER PROVIDER — 50/day each) ---
  // OpenRouter gets its own 50/day counter, separate from Gemini's.
  const today = new Date().toISOString().slice(0, 10);
  const usageId = (body.browserId || "anonymous") + "_openrouter_" + today;
  let usageCount = 0;
  let usageDb = null;
  try {
    usageDb = getDb();
    const usageRef = doc(usageDb, "aiUsage", usageId);
    const usageSnap = await getDoc(usageRef);
    usageCount = usageSnap.exists() ? (usageSnap.data().count || 0) : 0;
    if (usageCount >= FREE_DAILY_LIMIT) {
      return res.status(429).json({
        error: `You've used all ${FREE_DAILY_LIMIT} free OpenRouter edits for today. Try the Gemini model from the dropdown (also free), add your own key in Settings, or try again tomorrow.`,
        limitReached: true,
        provider: "openrouter",
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
  const validated = validateAndExtractHtml(result.text);
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

// ===== Phase 3: Streaming AI edit (SSE) =====
// POST /api/ai-edit?stream=1
//   body: same as non-streaming — { html, selector, instruction, browserId, provider, model }
//
// Response: Server-Sent Events stream
//   event: token
//   data: {"text": "..."}
//
//   event: done
//   data: {"html": "<full html>", "txId": "..."}
//
//   event: error
//   data: {"error": "...", "status": 502}
//
// Only streams for OpenAI-compatible providers (openrouter).
// For Gemini (no provider in body), falls back to the non-streaming handler
// (returns a single `done` event when complete).
//
// The streaming handler reuses the SAME quota checks, prompt construction,
// and provider-call conventions as the non-streaming handlers — it just
// flushes tokens as they arrive instead of waiting for the full response.

async function streamChatCompletion(providerId, model, systemPrompt, userPrompt, options, onToken) {
  // Returns the full text on completion. Calls onToken(text) for each chunk.
  let baseUrl, apiKey;
  if (providerId === "openrouter") {
    baseUrl = "https://openrouter.ai/api/v1";
    apiKey = process.env.OPENROUTER_API_KEY;
  } else {
    throw (function() { const e = new Error("Unknown provider"); e.status = 400; return e; })();
  }
  if (!apiKey) {
    const e = new Error("Provider not configured"); e.status = 503; throw e;
  }
  const headers = { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" };
  if (providerId === "openrouter") {
    headers["HTTP-Referer"] = "https://kayhosthtml.zone.id";
    headers["X-Title"] = "Kayhost HTML";
  }
  const timeoutMs = options.timeoutMs || 50000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 16000,
        stream: true,  // <-- request streaming
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let errBody = "";
      try { errBody = await res.text(); } catch (e) {}
      const e = new Error(providerId + " HTTP " + res.status + (errBody ? ": " + errBody.slice(0, 200) : ""));
      e.status = res.status === 429 ? 429 : 502;
      throw e;
    }
    // Read the stream
    const reader = res.body.getReader();
    const decoder = new (require("util").TextDecoder)();
    let buffer = "";
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();  // keep partial line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          const token = parsed?.choices?.[0]?.delta?.content || "";
          if (token) {
            fullText += token;
            if (onToken) onToken(token);
          }
        } catch (e) {
          // ignore parse errors on partial lines
        }
      }
    }
    return fullText;
  } finally {
    clearTimeout(timeout);
  }
}

// Streaming-aware main handler. Mounted at /api/ai-edit?stream=1
async function handleAiEditStream(req, res) {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");  // disable Nginx buffering (Vercel respects this)

  function sendEvent(event, data) {
    res.write("event: " + event + "\n");
    res.write("data: " + JSON.stringify(data) + "\n\n");
  }

  try {
    const body = req.body || {};
    const { html, instruction, provider, model, browserId } = body;
    if (!html || !instruction) {
      sendEvent("error", { error: "html and instruction are required", status: 400 });
      return res.end();
    }

    // Only stream for OpenAI-compatible providers. For Gemini (no provider),
    // tell the client to fall back to the non-streaming endpoint.
    if (!provider || provider !== "openrouter") {
      sendEvent("error", {
        error: "Streaming not supported for this provider. Use the non-streaming endpoint.",
        status: 400,
        fallback: true,
      });
      return res.end();
    }

    // Build the same prompt as the non-streaming handlers
    const systemPrompt = "You are a precise HTML editor. Return only complete valid HTML.";
    const userPrompt = "You are an HTML editor. The user has an HTML document and wants to change a specific part of it.\n\nHere is the complete HTML document:\n```html\n" + html + "\n```\n\nThe user selected the element matching this CSS selector: \"" + (body.selector || "body") + "\"\n\nThe user's instruction: \"" + instruction + "\"\n\nIMPORTANT INSTRUCTIONS:\n1. Apply the requested change to the selected element (or the whole document if no specific element).\n2. Return the COMPLETE updated HTML document — from <!DOCTYPE html> to </html>.\n3. Do NOT wrap the output in markdown code fences.\n4. Do NOT add any explanation, commentary, or text before or after the HTML.\n5. Do NOT change any part of the document that the user didn't ask to change.\n6. Keep all existing content intact unless the user explicitly asked to change it.\n\nReturn ONLY the raw HTML:";

    // Stream tokens
    let fullText;
    try {
      fullText = await streamChatCompletion(provider, model, systemPrompt, userPrompt, { timeoutMs: 50000 }, function(token) {
        sendEvent("token", { text: token });
      });
    } catch (err) {
      sendEvent("error", { error: err.message || "Provider error", status: err.status || 502 });
      return res.end();
    }

    if (!fullText || !fullText.trim()) {
      sendEvent("error", { error: "Empty response from provider", status: 502 });
      return res.end();
    }

    // Strip code fences if present
    let cleaned = fullText.trim();
    if (cleaned.startsWith("```html")) {
      cleaned = cleaned.replace(/^```html\s*/, "").replace(/\s*```$/, "");
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    if (!cleaned.toLowerCase().startsWith("<!doctype") && !cleaned.toLowerCase().startsWith("<html")) {
      const m = cleaned.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
      if (m) cleaned = m[0];
    }

    // Increment quota (best-effort, don't fail the stream over it)
    try {
      const db = getDb();
      const today = new Date().toISOString().slice(0, 10);
      if (provider === "openrouter") {
        const usageId = (browserId || "anonymous") + "_openrouter_" + today;
        const ref = doc(db, "aiUsage", usageId);
        const snap = await getDoc(ref);
        const count = snap.exists() ? (snap.data().count || 0) : 0;
        await setDoc(ref, { count: count + 1, browserId: browserId || "anonymous", date: today, provider: "openrouter", model }, { merge: true });
      }
      // For Gemini, the non-streaming handler does
      // the Pro-gating + quota. Streaming for those is best-effort and the
      // quota increment is skipped here to avoid duplicating the Pro check.
    } catch (e) {
      console.warn("[ai-edit:stream] quota increment failed:", e.message);
    }

    sendEvent("done", { html: cleaned });
    return res.end();
  } catch (err) {
    console.error("[ai-edit:stream] Error:", err);
    try { sendEvent("error", { error: err.message || "Stream error", status: 500 }); } catch (e) {}
    return res.end();
  }
}

// Export the streaming handler so api/ai-edit.js can dispatch to it
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden." });
  }
  // Stream mode?
  if (req.query.stream === "1" || req.query.stream === "true") {
    return handleAiEditStream(req, res);
  }
  // Otherwise: existing non-streaming flow — delegate to the original handler
  return handleAiEditOriginal(req, res);
};
