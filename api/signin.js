// /api/signin.js — Server-side email/password sign-in via Firebase REST API.
// Bypasses reCAPTCHA. Clean error messages for end users (no debug info).
const { getDb } = require("./_firebase");
const { doc, setDoc, getDoc, query, where, getDocs, collection } = require("firebase/firestore");

const FIREBASE_API_KEY = "AIzaSyB7BBI11ZGrKJ3P24RF9ja49FWHeX3kImQ";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Call Firebase REST API directly — no reCAPTCHA, no domain restrictions
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password: password,
          returnSecureToken: true,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      // Clean error messages — NO Firebase Console instructions shown to users
      const error = data.error || {};
      const code = error.message || "Sign-in failed";
      let msg = "Connection error. Please try again.";
      if (code.includes("INVALID_PASSWORD") || code.includes("INVALID_LOGIN_CREDENTIALS")) {
        msg = "Invalid email or password.";
      } else if (code.includes("EMAIL_NOT_FOUND")) {
        msg = "Invalid email or password.";
      } else if (code.includes("TOO_MANY_ATTEMPTS")) {
        msg = "Too many attempts. Please wait a few minutes and try again.";
      }
      return res.status(400).json({ error: msg });
    }

    // Success! Save user profile to Firestore — prevent duplicates by checking email
    try {
      const db = getDb();
      const userRef = doc(db, "users", data.localId);
      const userDoc = await getDoc(userRef);
      if (!userDoc.exists()) {
        // Check if a user with the same email already exists (different UID, same email)
        const emailQuery = query(collection(db, "users"), where("email", "==", data.email));
        const emailSnap = await getDocs(emailQuery);
        if (emailSnap.empty) {
          // No existing user with this email — create new
          await setDoc(userRef, {
            uid: data.localId,
            email: data.email,
            displayName: data.displayName || data.email,
            photoURL: data.photoUrl || "",
            provider: "password",
            createdAt: Date.now(),
            pro: false,
            suspended: false,
          });
        }
        // If a user with this email already exists, skip creating a duplicate
      }
    } catch (e) {
      // Firestore might not be set up — ignore, sign-in still works
    }

    // Return the user data + token
    return res.status(200).json({
      uid: data.localId,
      email: data.email,
      displayName: data.displayName || "",
      photoURL: data.photoUrl || "",
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      provider: "password",
    });
  } catch (err) {
    console.error("[signin] Error:", err);
    return res.status(500).json({ error: "Connection error. Please try again." });
  }
};
