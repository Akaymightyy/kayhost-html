// /api/save-user.js — Saves user profile to Firestore after Google/GitHub sign-in
// Called from the client after Firebase Auth succeeds (popup or redirect)
const { getDb } = require("./_firebase");
const { doc, setDoc, getDoc } = require("firebase/firestore");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { uid, email, displayName, photoURL, provider } = req.body || {};
    if (!uid) return res.status(400).json({ error: "uid required" });

    const db = getDb();
    // Only create if doesn't exist (don't overwrite existing profiles)
    const existing = await getDoc(doc(db, "users", uid));
    if (!existing.exists()) {
      await setDoc(doc(db, "users", uid), {
        uid,
        email: email || "",
        displayName: displayName || "",
        photoURL: photoURL || "",
        provider: provider || "unknown",
        createdAt: Date.now(),
        pro: false,
        suspended: false,
      });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[save-user] Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
