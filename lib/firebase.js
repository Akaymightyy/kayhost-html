// Shared Firebase init — uses the client SDK (firebase v10). This runs
// server-side in Vercel serverless functions.
//
// NOTE: Firebase's client-side web config (apiKey, authDomain, etc.) is
// designed by Google to be public — it identifies your project, it does not
// authorize access. Real security comes from Firestore Security Rules, not
// from hiding this config. It's fine to hardcode.
//
// This is DIFFERENT from your Firebase Admin SDK service account key
// (FIREBASE_SERVICE_ACCOUNT_KEY, used in _admin-firebase.js) and your Gemini
// API key (GEMINI_API_KEY, used in ai-edit.js) — those ARE real secrets and
// must stay in Vercel environment variables only, never hardcoded here.

const { initializeApp, getApps } = require("firebase/app");
const { getFirestore } = require("firebase/firestore");

const firebaseConfig = {
  apiKey: "AIzaSyB7BBI11ZGrKJ3P24RF9ja49FWHeX3kImQ",
  authDomain: "akaymightyy.firebaseapp.com",
  projectId: "akaymightyy",
  storageBucket: "akaymightyy.firebasestorage.app",
  messagingSenderId: "256670145750",
  appId: "1:256670145750:web:34579bad40ff78d5247d77",
  measurementId: "G-WJVHPTEHTB",
};

let _db = null;

function getDb() {
  if (_db) return _db;
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  _db = getFirestore(app);
  return _db;
}

module.exports = { getDb };
