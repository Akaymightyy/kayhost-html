// /api/signup.js — Creates a NEW email/password account via Firebase REST API,
// then signs the user in immediately (Firebase's signUp endpoint returns a
// session token just like sign-in does). Mirrors api/signin.js.
const { getDb } = require("./_firebase");
const { doc, setDoc, getDoc } = require("firebase/firestore");

// Public client config — safe to hardcode, see api/_firebase.js note.
const FIREBASE_API_KEY = "AIzaSyB7BBI11ZGrKJ3P24RF9ja49FWHeX3kImQ";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { email, password, displayName } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
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
      const error = data.error || {};
      const code = error.message || "Sign-up failed";
      let msg = code;
      if (code.includes("EMAIL_EXISTS")) {
        msg = "An account with that email already exists. Try signing in instead.";
      } else if (code.includes("WEAK_PASSWORD")) {
        msg = "Password is too weak. Use at least 6 characters.";
      } else if (code.includes("INVALID_EMAIL")) {
        msg = "That doesn't look like a valid email address.";
      } else if (code.includes("OPERATION_NOT_ALLOWED")) {
        msg = "Email/Password sign-up is not enabled. Go to Firebase Console → Authentication → Sign-in method → Enable Email/Password.";
      }
      return res.status(400).json({ error: msg, code });
    }

    // Success — save the new user's profile to Firestore
    try {
      const db = getDb();
      await setDoc(doc(db, "users", data.localId), {
        uid: data.localId,
        email: data.email,
        displayName: displayName || data.email,
        photoURL: "",
        provider: "password",
        createdAt: Date.now(),
      });
    } catch (e) {
      // Firestore might not be set up — ignore, account still works
    }

    return res.status(200).json({
      uid: data.localId,
      email: data.email,
      displayName: displayName || "",
      photoURL: "",
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      provider: "password",
    });
  } catch (err) {
    console.error("[signup] Error:", err);
    return res.status(500).json({ error: err.message || "Sign-up failed" });
  }
};
