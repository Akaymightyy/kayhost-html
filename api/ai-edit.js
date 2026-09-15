// /api/ai-edit.js — receives { html, selector, instruction }, calls Gemini to rewrite HTML
// Server-side only — never exposes the Gemini API key to the browser.
const { GoogleGenerativeAI } = require("@google/generative-ai");

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
    if (html.length > 500_000) {
      return res.status(413).json({ error: "HTML too large" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY not set in environment variables" });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Build the prompt for Gemini
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
7. If the selector refers to a specific element, only modify that element (and its children). Leave everything else untouched.

Return ONLY the raw HTML:`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let updatedHtml = response.text();

    // Clean up: remove markdown code fences if Gemini added them anyway
    updatedHtml = updatedHtml.trim();
    if (updatedHtml.startsWith("```html")) {
      updatedHtml = updatedHtml.replace(/^```html\s*/, "").replace(/\s*```$/, "");
    } else if (updatedHtml.startsWith("```")) {
      updatedHtml = updatedHtml.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    // Ensure it starts with <!DOCTYPE html> or <html
    if (!updatedHtml.toLowerCase().startsWith("<!doctype") && !updatedHtml.toLowerCase().startsWith("<html")) {
      // If Gemini returned something that's not HTML, it might have wrapped it
      // Try to extract just the HTML part
      const htmlMatch = updatedHtml.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
      if (htmlMatch) {
        updatedHtml = htmlMatch[0];
      }
    }

    return res.status(200).json({ html: updatedHtml });
  } catch (err) {
    console.error("[ai-edit] Error:", err);
    return res.status(500).json({ error: err.message || "AI edit failed" });
  }
};
