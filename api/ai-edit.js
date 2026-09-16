// /api/ai-edit.js — receives { html, selector, instruction }, calls Gemini to rewrite HTML.
// Server-side only — API key never exposed to browser.
//
// Requires GEMINI_API_KEY as a Vercel environment variable. Get a real key
// from https://aistudio.google.com/apikey — valid keys start with "AIzaSy".
// No hardcoded fallback — a missing/malformed key must fail loudly, not
// silently attempt a request that will always 400.

const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

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

    // Check if the key is present and looks like a real Gemini key
    if (!GEMINI_API_KEY || !GEMINI_API_KEY.startsWith("AIzaSy")) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is missing or malformed. Get a free key from https://aistudio.google.com/apikey (it should start with 'AIzaSy') and set it in Vercel → Settings → Environment Variables."
      });
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let updatedHtml = response.text();

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
    // Return a clean, user-facing error
    let msg = err.message || "AI edit failed";
    if (msg.includes("API key not valid")) {
      msg = "Gemini API key is invalid. Get a free key from https://aistudio.google.com/apikey";
    }
    return res.status(500).json({ error: msg });
  }
};
