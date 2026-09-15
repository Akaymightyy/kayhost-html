// /api/sites.js — lists all sites created by a browser ID
const { getDb } = require("./_firebase");
const { collection, query, where, getDocs, orderBy, limit } = require("firebase/firestore");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const browserId = req.query.browserId;
    if (!browserId) return res.status(200).json({ sites: [] });

    const db = getDb();
    // Note: Firestore requires a composite index for where + orderBy.
    // To avoid needing to create an index, we just use where and sort client-side.
    const q = query(collection(db, "sites"), where("browserId", "==", browserId));
    const snapshot = await getDocs(q);

    const sites = [];
    snapshot.forEach((doc) => {
      const d = doc.data();
      sites.push({
        id: d.id,
        title: d.title,
        createdAt: d.createdAt,
        expiresAt: d.expiresAt,
      });
    });

    // Sort client-side (newest first)
    sites.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return res.status(200).json({ sites: sites.slice(0, 50) });
  } catch (err) {
    console.error("[sites] Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
