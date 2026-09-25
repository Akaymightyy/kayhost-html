// /api/ai-providers.js — PUBLIC endpoint returning which AI providers are enabled.
// OpenRouter model list is fetched dynamically from OpenRouter's live /models endpoint.

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
    const providers = await getEnabledProviders();
    console.log("[ai-providers] Enabled:", providers.map(p => p.id + " (" + p.models.length + " models)").join(", ") || "(none)");
    return res.status(200).json({ providers });
  } catch (err) {
    console.error("[ai-providers] Error:", err.message || err);
    return res.status(200).json({ providers: [] });
  }
};
