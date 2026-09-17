// /api/ai-edit.js — receives { html, selector, instruction }, calls Gemini to rewrite HTML.
// Uses the new @google/genai SDK (replaces old @google/generative-ai).
// Accepts AQ.-format keys (new Google format) — no prefix validation.
const { GoogleGenAI } = require("@google/genai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6LjZ6Jn2oiBrQj6GkkOzjJk31FqW1kZda3PkFNXjpMF8Q";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { html, selector, instruction } = req.body || {};

    if (!html || !instruction) {
      return res.status(400).json({ error: "html and instruction are required" });
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

    // Try models in order — fallback if one is deprecated
    const models = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-1.5-flash", "gemini-flash-latest"];
    let response = null;
    let lastError = null;
    for (const modelName of models) {
      try {
        response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
        });
        break;
      } catch (modelErr) {
        lastError = modelErr;
        console.warn("[ai-edit] Model " + modelName + " failed:", modelErr.message?.slice(0, 100));
        continue;
      }
    }
    if (!response) throw lastError || new Error("All Gemini models failed");

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
