// /api/deploy.js — saves HTML to Firestore, returns site ID + URL
const { initFirebase } = require("./_firebase");

module.exports = async (req, res) => {
  // CORS + method guard
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { html, title, ttl, browserId } = req.body || {};
    
    if (!html || typeof html !== "string") {
      return res.status(400).json({ error: "HTML content required" });
    }
    if (html.length > 500_000) {
      return res.status(413).json({ error: "HTML too large (max 500KB)" });
    }

    // Generate a short random ID (6 chars = ~2 billion possibilities)
    const id = Math.random().toString(36).slice(2, 8);
    
    // Calculate expiry
    const now = Date.now();
    let expiresAt = null;
    if (ttl === "1d") expiresAt = now + 86400000;
    else if (ttl === "7d") expiresAt = now + 604800000;
    else if (ttl === "30d") expiresAt = now + 2592000000;
    // "never" → expiresAt stays null

    const { db } = initFirebase();
    await db.collection("sites").doc(id).set({
      id,
      html,
      title: title || "Untitled",
      browserId: browserId || "anonymous",
      createdAt: now,
      expiresAt, // null = never expires
    });

    // Return the public URL
    const baseUrl = process.env.KAYHOST_BASE_URL || `https://${req.headers.host}`;
    const url = `${baseUrl}/site/${id}`;

    return res.status(200).json({ id, url, expiresAt });
  } catch (err) {
    console.error("[deploy] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to deploy" });
  }
};
