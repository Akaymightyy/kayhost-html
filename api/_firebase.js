// Shared Firebase Admin init — used by all /api routes
// Reads credentials from Vercel environment variables.
const admin = require("firebase-admin");

let _db = null;
let _storage = null;

function initFirebase() {
  if (_db) return { db: _db, storage: _storage };
  
  // Only initialize once
  if (admin.apps.length === 0) {
    // Use service account credentials from env vars
    // Either set FIREBASE_SERVICE_ACCOUNT_JSON (the full JSON key)
    // Or set individual FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    
    if (serviceAccountJson) {
      // Parse the full service account JSON
      const serviceAccount = JSON.parse(serviceAccountJson);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`,
      });
    } else {
      // Use individual env vars
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        }),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      });
    }
  }
  
  _db = admin.firestore();
  _storage = admin.storage ? admin.storage() : null;
  return { db: _db, storage: _storage };
}

module.exports = { initFirebase, admin };
