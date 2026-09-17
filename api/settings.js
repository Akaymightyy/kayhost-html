// /api/settings.js — PUBLIC settings endpoint
// Returns ONLY settings safe to expose to all visitors (no admin flags, no secrets).
// Currently exposes:
//   - chatWidget: the raw HTML/JS embed code for a chat widget (e.g. Tawk.to)
//
// Anything sensitive must stay gated behind /api/admin (which is admin-only).
const { getDb } = require("./_firebase");
const { doc, getDoc } = require("firebase/firestore");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  let db;
  try {
    db = getDb();
  } catch (e) {
    return res.status(200).json({ chatWidget: "" });
  }

  try {
    // Try to fetch the chatWidget setting doc
    let chatWidget = "";
    try {
      const snap = await getDoc(doc(db, "settings", "chatWidget"));
      if (snap.exists()) {
        const data = snap.data() || {};
        chatWidget = typeof data.value === "string" ? data.value : "";
      }
    } catch (e) {}

    return res.status(200).json({
      chatWidget,
      // Other public settings can go here later
    });
  } catch (err) {
    console.error("[settings] Error:", err);
    return res.status(200).json({ chatWidget: "" });
  }
};
