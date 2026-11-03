// /api/ai-generate.js — Generate a full HTML page from a natural-language prompt.
//
// Body: { prompt, browserId, provider?, model?, apiKey? }
//   - prompt:       "Build a portfolio for my design work, warm neutrals, large type"
//   - browserId:    for daily quota tracking (same 50/day counter as ai-edit)
//   - provider:     "gemini" (default) | "openrouter" | "byok"
//   - model:        optional model override
//   - apiKey:       required when provider === "byok"
//
// Returns: { html: "<!DOCTYPE html>...</html>" }
//
// Free-tier limit: 50 generations per browserId per UTC day (shared with ai-edit
// via the same aiUsage collection, provider="gemini").
//
// The system prompt is tuned to produce a complete, self-contained HTML5
// document with inline CSS — no external assets, no JavaScript frameworks.

const { GoogleGenAI } = require("@google/genai");
const { getDb } = require("../lib/firebase");
const { doc, getDoc, setDoc } = require("firebase/firestore");
const aiProviders = require("../lib/ai-providers");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const FREE_DAILY_LIMIT = 50;

const SYSTEM_PROMPT = `You are an expert web designer and front-end developer. Generate a complete, production-ready HTML page based on the user's description.

STRICT REQUIREMENTS:
1. Output MUST be a single self-contained <!DOCTYPE html> document
2. All CSS must be inline (in <style> tags inside <head>) — no external stylesheets
3. No external JavaScript frameworks (no React, Vue, jQuery, etc.) — only vanilla JS if absolutely needed
4. No external images — use CSS gradients, SVG, or unsplash.com source URLs (https://source.unsplash.com/...) if photos are needed
5. Must be fully responsive (mobile-first, with a desktop layout at min-width: 768px)
6. Use modern CSS (flexbox/grid, custom properties, smooth transitions)
7. Use system fonts: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
8. Include proper <meta> tags (viewport, description, og:title, og:description)
9. The page must look polished and complete — not a skeleton
10. Include realistic placeholder content (not "Lorem ipsum") that matches the user's described purpose
11. End with a complete </html> tag — no markdown, no code fences, no explanations

DESIGN PRINCIPLES:
- Generous whitespace and breathing room
- Strong visual hierarchy (clear hero, supporting sections, calls to action)
- Modern aesthetic — think Linear, Vercel, Stripe landing pages
- Accessible color contrast (WCAG AA)
- Subtle animations (fade-in on scroll, hover states) using CSS only

OUTPUT FORMAT: Return ONLY the HTML document. No preamble, no markdown fences, no postscript.`;

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
    if (m) t = m[0];
    else return { ok: false };
  }
  if (!/<\/html>\s*$/i.test(t)) return { ok: false };
  return { ok: true, html: t };
}

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

  if (isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden." });
  }

  try {
    const { prompt, browserId, provider, model, apiKey } = req.body || {};

    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 10) {
      return res.status(400).json({ error: "prompt is required (min 10 chars)" });
    }
    if (prompt.length > 2000) {
      return res.status(400).json({ error: "prompt too long (max 2000 chars)" });
    }

    // --- BYOK branch ---
    if (provider === "byok") {
      if (!apiKey) return res.status(400).json({ error: "apiKey required for BYOK" });
      const genAI = new GoogleGenAI({ apiKey });
      const response = await genAI.models.generateContent({
        model: model || "gemini-2.5-flash",
        contents: prompt,
        config: { systemInstruction: SYSTEM_PROMPT, temperature: 0.9, maxOutputTokens: 16000 },
      });
      const text = response.text || "";
      const result = validateAndExtractHtml(text);
      if (!result.ok) {
        return res.status(502).json({ error: "AI did not return valid HTML. Try again with a more specific prompt.", raw: text.slice(0, 500) });
      }
      return res.status(200).json({ html: result.html });
    }

    // --- OpenRouter branch (free) ---
    if (provider === "openrouter") {
      // Reuse the same provider-call pattern from ai-edit
      const ORresult = await aiProviders.callProvider({
        provider: "openrouter",
        model: model || "deepseek/deepseek-chat-v3.1:free",
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: prompt,
      });
      const result = validateAndExtractHtml(ORresult.text || "");
      if (!result.ok) {
        return res.status(502).json({ error: "OpenRouter did not return valid HTML.", raw: (ORresult.text || "").slice(0, 500) });
      }
      return res.status(200).json({ html: result.html });
    }

    // --- Gemini default branch (server key) ---
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server missing GEMINI_API_KEY env var. Set it in Vercel → Project → Settings → Environment Variables." });
    }

    // Quota check (per browserId, per day, shared with ai-edit)
    const today = new Date().toISOString().slice(0, 10);
    const usageId = (browserId || "anonymous") + "_gemini_" + today;
    const db = getDb();
    const usageSnap = await getDoc(doc(db, "aiUsage", usageId));
    const used = usageSnap.exists() ? (usageSnap.data().count || 0) : 0;
    if (used >= FREE_DAILY_LIMIT) {
      return res.status(429).json({
        error: `Daily limit reached (${FREE_DAILY_LIMIT} AI actions per day). Try again tomorrow or use your own API key (BYOK).`,
        used, limit: FREE_DAILY_LIMIT,
      });
    }

    const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const response = await genAI.models.generateContent({
      model: model || "gemini-2.5-flash",
      contents: prompt,
      config: { systemInstruction: SYSTEM_PROMPT, temperature: 0.9, maxOutputTokens: 16000 },
    });
    const text = response.text || "";
    const result = validateAndExtractHtml(text);
    if (!result.ok) {
      return res.status(502).json({ error: "AI did not return valid HTML. Try again with a more specific prompt.", raw: text.slice(0, 500) });
    }

    // Count against quota only on success
    await setDoc(doc(db, "aiUsage", usageId), { count: used + 1, updatedAt: Date.now() }, { merge: true });

    return res.status(200).json({ html: result.html });
  } catch (err) {
    console.error("[ai-generate] Error:", err);
    return res.status(500).json({ error: err.message || "AI generation failed" });
  }
};
