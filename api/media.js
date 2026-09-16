// /api/media.js — uploads an image to Cloudinary, returns public URL.
// Uses unsigned upload (no API key/secret needed in the code — just cloud name + preset).
//
// Cloudinary credentials:
//   Cloud Name:  ← find this on your Cloudinary dashboard (top of the page)
//   Upload Preset: kayhost (unsigned, already created ✓)
//   API Key: 652486594789793 (not needed for unsigned uploads)
//   API Secret: MefO3eGxeofAvNNR-Bd--a4JXNs (not needed for unsigned uploads)

// ⚠️ REPLACE THIS with your Cloud Name (it's at the top of your Cloudinary dashboard).
// It's a string like "dkayhost" or "akaymightyy" — NOT a number.
const CLOUDINARY_CLOUD_NAME = "dbmtqgs3v";
const CLOUDINARY_UPLOAD_PRESET = "kayhost";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (CLOUDINARY_CLOUD_NAME === "REPLACE_WITH_YOUR_CLOUD_NAME") {
      return res.status(500).json({
        error: "Cloudinary cloud name not set. Open api/media.js and replace REPLACE_WITH_YOUR_CLOUD_NAME with your cloud name (from your Cloudinary dashboard)."
      });
    }

    const { data, filename, mimeType } = req.body || {};
    if (!data) return res.status(400).json({ error: "No image data" });

    // Upload to Cloudinary using unsigned upload
    const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
    const formData = new (require("url").URLSearchParams)();
    formData.append("file", data);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const uploadRes = await fetch(cloudinaryUrl, {
      method: "POST",
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      return res.status(500).json({ error: `Cloudinary error: ${err}` });
    }

    const result = await uploadRes.json();
    return res.status(200).json({ url: result.secure_url });
  } catch (err) {
    console.error("[media] Error:", err);
    return res.status(500).json({ error: err.message || "Upload failed" });
  }
};
