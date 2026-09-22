// /api/ashna-models.js — PUBLIC endpoint that returns the list of AshnaAI models
// available to Pro users in the visual HTML editor.
//
// Returns: { models: [...], defaultModel: "...|null", error?: "..." }
//   models        — Array of { id, displayName, capability: "html-editing", endpoint: "chat-completions" }
//   defaultModel  — String or null
//   error         — String or null (only included when models is empty; safe to display)
//
// NEVER returns the API key. If the key is missing, the allowlist is empty,
// or Ashna is unreachable, returns an empty list with a safe message.
//
// Cached in memory for 10 minutes (see lib/ashna.js).

const { fetchAshnaModels } = require("../lib/ashna");

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden." });
  }

  try {
    const { list, defaultModel, error } = await fetchAshnaModels();
    const body = { models: list, defaultModel };
    if (error && list.length === 0) body.error = error;
    return res.status(200).json(body);
  } catch (err) {
    // Defensive — fetchAshnaModels should never throw, but if it does:
    console.error("[ashna-models] Unexpected error:", err.message || err);
    return res.status(200).json({
      models: [],
      defaultModel: null,
      error: "AshnaAI unavailable",
    });
  }
};
