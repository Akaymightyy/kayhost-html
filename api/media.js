// /api/media.js — uploads an image to Firebase Storage, returns public URL
const { initFirebase } = require("./_firebase");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { storage } = initFirebase();
    if (!storage) {
      return res.status(500).json({ error: "Firebase Storage not initialized" });
    }

    // Vercel serverless functions parse the body differently
    // For file uploads, we need to read the raw body
    const contentType = req.headers["content-type"] || "";
    
    if (contentType.startsWith("application/json")) {
      // JSON body with base64-encoded image data
      const { data, filename, mimeType } = req.body || {};
      if (!data) return res.status(400).json({ error: "No image data provided" });
      
      const buffer = Buffer.from(data.split(",")[1] || data, "base64");
      const ext = (filename || "image").split(".").pop();
      const path = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      
      const bucket = storage.bucket();
      const file = bucket.file(path);
      await file.save(buffer, {
        metadata: { contentType: mimeType || "image/png" },
      });
      
      // Make it publicly accessible
      await file.makePublic();
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${path}`;
      
      return res.status(200).json({ url: publicUrl });
    }
    
    return res.status(400).json({ error: "Expected application/json with base64 image data" });
  } catch (err) {
    console.error("[media] Error:", err);
    return res.status(500).json({ error: err.message || "Upload failed" });
  }
};
