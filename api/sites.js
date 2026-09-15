// /api/sites.js — lists all sites created by a browser ID
const { initFirebase } = require("./_firebase");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const browserId = req.query.browserId;
    if (!browserId) {
      return res.status(200).json({ sites: [] });
    }

    const { db } = initFirebase();
    const snapshot = await db.collection("sites")
      .where("browserId", "==", browserId)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const sites = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      sites.push({
        id: data.id,
        title: data.title,
        createdAt: data.createdAt,
        expiresAt: data.expiresAt,
      });
    });

    return res.status(200).json({ sites });
  } catch (err) {
    console.error("[sites] Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
