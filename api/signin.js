// /api/signin.js — Server-side email/password sign-in via Firebase REST API.
// This BYPASSES reCAPTCHA (which the Firebase SDK v10 uses by default and which
// fails on custom domains). The browser sends email+password here, the server
// calls Firebase directly, returns the user token + profile.
const { getDb } = require("./_firebase");
const { doc, setDoc, getDoc } = require("firebase/firestore");

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!FIREBASE_API_KEY) {
      return res.status(500).json({ error: "FIREBASE_API_KEY is not configured in Vercel environment variables." });
    }
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
      // Translate Firebase REST API errors to clean messages
      const error = data.error || {};
      const code = error.message || "Sign-in failed";
      let msg = code;
      if (code.includes("INVALID_PASSWORD") || code.includes("INVALID_LOGIN_CREDENTIALS")) {
        msg = "Wrong email or password. Check that the account exists in Firebase Console → Authentication → Users.";
      } else if (code.includes("EMAIL_NOT_FOUND")) {
        msg = "No account found with that email. Create it in Firebase Console → Authentication → Users → Add User.";
      } else if (code.includes("TOO_MANY_ATTEMPTS")) {
        msg = "Too many failed attempts. Wait 5 minutes and try again.";
      } else if (code.includes("OPERATION_NOT_ALLOWED")) {
        msg = "Email/Password sign-in is not enabled. Go to Firebase Console → Authentication → Sign-in method → Enable Email/Password.";
      } else if (code.includes("API_KEY_NOT_VALID")) {
        msg = "Firebase API key is not valid. Check the API key in api/signin.js.";
      } else if (code.includes("NETWORK_ERROR")) {
        msg = "Can't reach Firebase. Check your Firebase project settings.";
      }
      return res.status(400).json({ error: msg, code });
    }

    // Success! Save user profile to Firestore if not already there
    try {
      const db = getDb();
      const userDoc = await getDoc(doc(db, "users", data.localId));
      if (!userDoc.exists()) {
        await setDoc(doc(db, "users", data.localId), {
          uid: data.localId,
          email: data.email,
          displayName: data.displayName || data.email,
          photoURL: data.photoUrl || "",
          provider: "password",
          createdAt: Date.now(),
        });
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
    return res.status(500).json({ error: err.message || "Sign-in failed" });
  }
};
