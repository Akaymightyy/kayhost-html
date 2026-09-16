// Shared Firebase init — uses the client SDK (firebase v10), config pulled
// from environment variables. This runs server-side in Vercel serverless
// functions.
//
// NOTE: Firebase's client-side web config (apiKey, authDomain, etc.) is
// designed by Google to be public — it identifies your project, it does not
// authorize access. Real security comes from Firestore Security Rules, not
// from hiding this config. It's pulled from env vars here for cleanliness
// and easier rotation, not because leaking it is a breach on its own.
// Set these in Vercel → Settings → Environment Variables.

const { initializeApp, getApps } = require("firebase/app");
const { getFirestore } = require("firebase/firestore");

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID,
};

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  console.error(
    "[_firebase] Missing Firebase env vars. Set FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, " +
    "FIREBASE_PROJECT_ID, FIREBASE_STORAGE_BUCKET, FIREBASE_MESSAGING_SENDER_ID, FIREBASE_APP_ID " +
    "in Vercel → Settings → Environment Variables."
  );
}

let _db = null;

function getDb() {
  if (_db) return _db;
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  _db = getFirestore(app);
  return _db;
}

module.exports = { getDb };
