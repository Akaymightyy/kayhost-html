// Shared Firebase init — uses the client SDK (firebase v10) with hardcoded config.
// This runs server-side in Vercel serverless functions. The browser never sees
// this code — only the HTTP response. Safe to hardcode as long as your GitHub
// repo is private (or you don't mind the config being public — Firebase web
// config is designed to be public anyway; security is enforced by Firestore Rules).

const { initializeApp, getApps } = require("firebase/app");
const { getFirestore } = require("firebase/firestore");

// Your Firebase web app config — hardcoded, no env vars needed.
const firebaseConfig = {
  apiKey: "AIzaSyB7BBI11ZGrKJ3P24RF9ja49FWHeX3kImQ",
  authDomain: "akaymightyy.firebaseapp.com",
  projectId: "akaymightyy",
  storageBucket: "akaymightyy.firebasestorage.app",
  messagingSenderId: "256670145750",
  appId: "1:256670145750:web:34579bad40ff78d5247d77",
  measurementId: "G-WJVHPTEHTB"
};

let _db = null;

function getDb() {
  if (_db) return _db;
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  _db = getFirestore(app);
  return _db;
}

module.exports = { getDb };
