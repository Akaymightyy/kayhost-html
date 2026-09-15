// /api/media.js — uploads an image to Firebase Storage, returns public URL.
// Uses the Firebase client SDK (hardcoded config).
const { initializeApp, getApps } = require("firebase/app");
const { getStorage, ref, uploadBytes, getDownloadURL } = require("firebase/storage");

const firebaseConfig = {
  apiKey: "AIzaSyB7BBI11ZGrKJ3P24RF9ja49FWHeX3kImQ",
  authDomain: "akaymightyy.firebaseapp.com",
  projectId: "akaymightyy",
  storageBucket: "akaymightyy.firebasestorage.app",
  messagingSenderId: "256670145750",
  appId: "1:256670145750:web:34579bad40ff78d5247d77",
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { data, filename, mimeType } = req.body || {};
    if (!data) return res.status(400).json({ error: "No image data provided" });

    // Convert base64 to buffer
    const buffer = Buffer.from(data.split(",")[1] || data, "base64");
    const ext = (filename || "image").split(".").pop();
    const path = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    // Init Firebase Storage
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    const storage = getStorage(app);
    const storageRef = ref(storage, path);

    // Upload
    await uploadBytes(storageRef, buffer, { contentType: mimeType || "image/png" });
    const publicUrl = await getDownloadURL(storageRef);

    return res.status(200).json({ url: publicUrl });
  } catch (err) {
    console.error("[media] Error:", err);
    return res.status(500).json({ error: err.message || "Upload failed" });
  }
};
