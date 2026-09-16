// /api/ai-edit.js — receives { html, selector, instruction }, calls Gemini to rewrite HTML.
// Server-side only — API key never exposed to browser.
//
// The key "Kayhost_API_Key" is NOT a valid Gemini API key.
// You need a real key from https://aistudio.google.com/apikey (starts with "AIza...")
//
// Option 1: Set GEMINI_API_KEY in Vercel → Settings → Environment Variables
// Option 2: Hardcode it below (replace the string below with your real key)

const { GoogleGenerativeAI } = require("@google/generative-ai");

// Use env var if set, otherwise use the hardcoded key.
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

    // Check if the key is valid (not a placeholder)
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_KEY_HERE" || GEMINI_API_KEY.length < 20) {
      return res.status(500).json({
        error: "Gemini API key not configured. Get a free key from https://aistudio.google.com/apikey and add it to api/ai-edit.js or set GEMINI_API_KEY in Vercel env vars."
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
