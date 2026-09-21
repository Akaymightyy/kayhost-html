// api/_admin-firebase.js — Firebase Admin SDK init, used ONLY server-side
// for verifying ID tokens. Never import this from client-side code.
//
// Requires FIREBASE_SERVICE_ACCOUNT_KEY as a Vercel environment variable —
// the full JSON key downloaded from:
// Firebase Console → Project Settings → Service Accounts → Generate new private key
// Paste the entire JSON content as the env var value (as a single-line string).

const admin = require("firebase-admin");

let _initialized = false;

function getAdmin() {
  if (_initialized) return admin;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_KEY is not set. Generate one from Firebase Console → " +
      "Project Settings → Service Accounts → Generate new private key, then add the " +
      "full JSON as a Vercel environment variable."
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON. Check the env var value.");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  _initialized = true;
  return admin;
}

// Verifies the Bearer token from the Authorization header.
// Returns the decoded, VERIFIED token (uid, email, etc.) or throws.
// Never trust uid/email sent directly in the request body/query — always
// derive them from this verified token instead.
async function verifyRequestToken(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    const err = new Error("Missing Authorization: Bearer <token> header");
    err.status = 401;
    throw err;
  }
  const token = match[1];
  const adm = getAdmin();
  try {
    const decoded = await adm.auth().verifyIdToken(token);
    return decoded; // { uid, email, ... } — verified by Firebase, not client-supplied
  } catch (e) {
    const err = new Error("Invalid or expired token");
    err.status = 401;
    throw err;
  }
}

module.exports = { getAdmin, verifyRequestToken };
