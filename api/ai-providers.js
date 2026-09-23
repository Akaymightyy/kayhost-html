// /api/ai-providers.js — PUBLIC endpoint that returns which free-tier AI providers
// are currently enabled (OpenCode Zen, AgentRouter). The frontend uses this to
// build the model dropdown dynamically — only showing providers whose API keys
// are set as env vars.
//
// Returns: { providers: [{ id, label, models: [{ id, displayName, ... }] }] }
// Never includes API keys.

const { getEnabledProviders } = require("../lib/ai-providers");

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
    const providers = getEnabledProviders();
    console.log("[ai-providers] Enabled:", providers.map(p => p.id + " (" + p.models.length + " models)").join(", ") || "(none)");
    return res.status(200).json({ providers });
  } catch (err) {
    console.error("[ai-providers] Error:", err.message || err);
    return res.status(200).json({ providers: [] });
  }
};
