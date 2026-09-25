// /api/serve.js — serves files from a project's file tree stored in Firestore.
// Used when a user uploads a folder/zip — the project is stored as:
//   { projectId, files: { "index.html": "...", "css/style.css": "...", ... } }
//
// Routes:
//   GET /api/serve?project=PROJECT_ID          → serves index.html
//   GET /api/serve?project=PROJECT_ID&path=css/style.css → serves that file
//
// Content types are inferred from file extensions. Files not found return 404.

const { getDb } = require("../lib/firebase");
const { doc, getDoc } = require("firebase/firestore");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function getMimeType(filename) {
  const ext = (filename || "").toLowerCase().match(/\.[^.]+$/);
  if (ext && MIME_TYPES[ext[0]]) return MIME_TYPES[ext[0]];
  return "application/octet-stream";
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const projectId = req.query.project;
  const filePath = req.query.path || "index.html";

  if (!projectId) {
    return res.status(400).send("Missing project ID");
  }

  let db;
  try { db = getDb(); } catch (e) {
    return res.status(500).send("Database not configured");
  }

  try {
    const snap = await getDoc(doc(db, "projects", projectId));
    if (!snap.exists()) {
      return res.status(404).send("Project not found");
    }
    const data = snap.data();
    const files = data.files || {};
    const content = files[filePath];
    if (content === undefined) {
      return res.status(404).send("File not found: " + filePath);
    }
    res.setHeader("Content-Type", getMimeType(filePath));
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).send(content);
  } catch (err) {
    console.error("[serve] Error:", err.message);
    return res.status(500).send("Server error");
  }
};
