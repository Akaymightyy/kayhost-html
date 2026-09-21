// /api/ai-edit.js — receives { html, selector, instruction, browserId }, calls Gemini to rewrite HTML.
// Uses the new @google/genai SDK (replaces old @google/generative-ai).
// Accepts AQ.-format keys (new Google format) — no prefix validation.
// Free-tier daily limit: 10 edits per browserId per UTC day, tracked in Firestore
// (collection "aiUsage", doc id `${browserId}_${YYYY-MM-DD}`). BYOK edits (Claude/GPT,
// and a user's own Gemini key) never touch this route, so they're never limited here.
const { GoogleGenAI } = require("@google/genai");
const { getDb } = require("./_firebase");
const { doc, getDoc, setDoc } = require("firebase/firestore");

// SECURITY: GEMINI_API_KEY must be set as a Vercel env var — never hardcoded.
// The previous hardcoded fallback was exposed when the site was mirrored with
// `wget --mirror` and the bundled function source leaked. Now there's NO
// fallback — if the env var is missing, the function returns a clear error.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const FREE_DAILY_LIMIT = 10;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { html, selector, instruction, browserId } = req.body || {};

    if (!html || !instruction) {
      return res.status(400).json({ error: "html and instruction are required" });
    }

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
