// /api/user-profile.js — PUBLIC endpoint that returns ONE user's profile
// (the signed-in user's own profile only).
//
// Why this exists: previously `syncUserToWindow` fetched `/api/admin?section=users`
// to read the current user's Pro status — which leaked the ENTIRE user list to
// any anonymous visitor. Now the client fetches just its own profile via this
// endpoint, and `/api/admin?section=users` is locked to admins only.
//
// Required query params:
//   email=foo@bar.com   OR   uid=abc123
// Returns:
//   { user: { uid, email, displayName, photoURL, pro, suspended, provider, createdAt } }
//   or { user: null } if not found
const { getDb } = require("./_firebase");
const { doc, getDoc, query, where, getDocs, collection } = require("firebase/firestore");

// Block scraper/bot User-Agents at the function level.
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  // Block scrapers
  if (isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden." });
  }

  let db;
  try { db = getDb(); } catch (e) {
    return res.status(200).json({ user: null });
  }

  try {
    const email = (req.query.email || "").trim().toLowerCase();
    const uid = (req.query.uid || "").trim();

    if (!email && !uid) {
      return res.status(400).json({ error: "email or uid required" });
    }

    let userDoc = null;

    // Try by UID first (most direct)
    if (uid) {
      try {
        const snap = await getDoc(doc(db, "users", uid));
        if (snap.exists()) userDoc = { uid: snap.id, ...snap.data() };
      } catch (e) {}
    }

    // Fall back to email query (handles merged-duplicate case where uid doesn't match
    // but the email does — see save-user.js merge logic)
    if (!userDoc && email) {
      try {
        const emailQuery = query(collection(db, "users"), where("email", "==", email));
        const emailSnap = await getDocs(emailQuery);
        if (!emailSnap.empty) {
          emailSnap.forEach(d => {
            if (!userDoc) userDoc = { uid: d.id, ...d.data() };
          });
        }
      } catch (e) {}
    }

    if (!userDoc) {
      return res.status(200).json({ user: null });
    }

    // Only expose the safe public fields — never expose internal flags like
    // _duplicateUids (those are for admin dashboard only)
    const safeUser = {
      uid: userDoc.uid,
      email: userDoc.email || "",
      displayName: userDoc.displayName || "",
      photoURL: userDoc.photoURL || "",
      provider: userDoc.provider || "unknown",
      pro: !!userDoc.pro,
      suspended: !!userDoc.suspended,
      createdAt: userDoc.createdAt || null,
    };

    return res.status(200).json({ user: safeUser });
  } catch (err) {
    console.error("[user-profile] Error:", err);
    return res.status(200).json({ user: null });
  }
};
