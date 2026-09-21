// /api/auth.js — consolidated auth dispatcher
// Handles: signin, signup via ?route= parameter
//
// vercel.json rewrites:
//   /api/signin → /api/auth?route=signin
//   /api/signup → /api/auth?route=signup
//
// Logic preserved EXACTLY from old api/signin.js and api/signup.js — only the
// file container changed.

const { getDb } = require("../lib/firebase");
const { doc, setDoc, getDoc, query, where, getDocs, collection } = require("firebase/firestore");

// Public client config — safe to hardcode, see lib/firebase.js note.
const FIREBASE_API_KEY = "AIzaSyB7BBI11ZGrKJ3P24RF9ja49FWHeX3kImQ";

// Shared scraper-blocker
function isScraperUa(ua) {
  if (!ua || ua.length < 20) return true;
  const lower = ua.toLowerCase();
  const patterns = ["wget", "curl", "httrack", "scrapy", "python-requests", "python-httpx",
    "python-urllib", "httpclient", "mechanize", "node-fetch", "got/", "axios/",
    "go-http-client", "okhttp", "spider", "crawler", "archive.org", "ahrefsbot",
    "semrush", "bytespider"];
  return patterns.some(p => lower.includes(p));
}

// --- route=signin (from old api/signin.js) ---
async function handleSignin(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, returnSecureToken: true }),
      }
    );
    const data = await response.json();
    if (!response.ok) {
      const error = data.error || {};
      const code = error.message || "Sign-in failed";
      let msg = "Connection error. Please try again.";
      if (code.includes("INVALID_PASSWORD") || code.includes("INVALID_LOGIN_CREDENTIALS")) msg = "Invalid email or password.";
      else if (code.includes("EMAIL_NOT_FOUND")) msg = "Invalid email or password.";
      else if (code.includes("TOO_MANY_ATTEMPTS")) msg = "Too many attempts. Please wait a few minutes and try again.";
      return res.status(400).json({ error: msg });
    }
    try {
      const db = getDb();
      const userRef = doc(db, "users", data.localId);
      const userDoc = await getDoc(userRef);
      if (!userDoc.exists()) {
        const emailQuery = query(collection(db, "users"), where("email", "==", data.email));
        const emailSnap = await getDocs(emailQuery);
        if (emailSnap.empty) {
          await setDoc(userRef, {
            uid: data.localId, email: data.email, displayName: data.displayName || data.email,
            photoURL: data.photoUrl || "", provider: "password", createdAt: Date.now(),
            pro: false, suspended: false,
          });
        }
      }
    } catch (e) { /* Firestore might not be set up — sign-in still works */ }
    return res.status(200).json({
      uid: data.localId, email: data.email, displayName: data.displayName || "",
      photoURL: data.photoUrl || "", idToken: data.idToken,
      refreshToken: data.refreshToken, provider: "password",
    });
  } catch (err) {
    console.error("[signin] Error:", err);
    return res.status(500).json({ error: "Connection error. Please try again." });
  }
}

// --- route=signup (from old api/signup.js) ---
async function handleSignup(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { email, password, displayName } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, returnSecureToken: true }),
      }
    );
    const data = await response.json();
    if (!response.ok) {
      const error = data.error || {};
      const code = error.message || "Sign-up failed";
      let msg = code;
      if (code.includes("EMAIL_EXISTS")) msg = "An account with that email already exists. Try signing in instead.";
      else if (code.includes("WEAK_PASSWORD")) msg = "Password is too weak. Use at least 6 characters.";
      else if (code.includes("INVALID_EMAIL")) msg = "That doesn't look like a valid email address.";
      else if (code.includes("OPERATION_NOT_ALLOWED")) msg = "Email/Password sign-up is not enabled. Go to Firebase Console → Authentication → Sign-in method → Enable Email/Password.";
      return res.status(400).json({ error: msg, code });
    }
    try {
      const db = getDb();
      await setDoc(doc(db, "users", data.localId), {
        uid: data.localId, email: data.email, displayName: displayName || data.email,
        photoURL: "", provider: "password", createdAt: Date.now(),
      });
    } catch (e) { /* Firestore might not be set up */ }
    return res.status(200).json({
      uid: data.localId, email: data.email, displayName: displayName || "",
      photoURL: "", idToken: data.idToken, refreshToken: data.refreshToken, provider: "password",
    });
  } catch (err) {
    console.error("[signup] Error:", err);
    return res.status(500).json({ error: err.message || "Sign-up failed" });
  }
}

// ===== Dispatcher =====
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden. Use a real browser." });
  }
  const route = req.query.route || "";
  switch (route) {
    case "signin": return handleSignin(req, res);
    case "signup": return handleSignup(req, res);
    default: return res.status(404).json({ error: "Unknown auth route: " + (route || "(missing)") });
  }
};
