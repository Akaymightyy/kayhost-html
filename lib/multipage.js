// lib/multipage.js — shared helpers for multi-page site support (Phase 1).
//
// A "project" is a multi-page site stored in Firestore collection `projects`.
// Each project doc looks like:
//   {
//     id: "abc123",
//     title: "My Site",
//     browserId: "user-xyz",
//     createdAt: 1695...,
//     expiresAt: 1695... | null,
//     files: {
//       "index.html":          "<!DOCTYPE html>...",
//       "about.html":          "<!DOCTYPE html>...",
//       "contact.html":        "<!DOCTYPE html>...",
//       "css/style.css":       "body { ... }",
//       "js/main.js":          "console.log('hi');",
//       "images/logo.png":     "<base64-or-data-uri>"   // see note below
//     },
//     pathMap: {
//       "/":            "index.html",
//       "/about":       "about.html",
//       "/contact":     "contact.html",
//       "/css/style.css": "css/style.css",
//       "/js/main.js":    "js/main.js"
//     }
//   }
//
// IMPORTANT: This module is 100% ADDITIVE. The existing `sites` collection
// (single HTML blob) is untouched — multi-page only kicks in when the
// frontend sends a `files` object instead of a single `html` string.
//
// NOTE on binary assets (images/fonts): Firestore docs are limited to 1MB per
// field. For Phase 1 we store small text files (HTML/CSS/JS) directly in the
// `files` map. Binary assets should be uploaded to Cloudinary (existing
// /api/media route) and referenced by URL — the frontend already does this
// for images. We do NOT try to store base64 images in Firestore.

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml":  "application/xml; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf":  "font/ttf",
  ".otf":  "font/otf",
  ".eot":  "application/vnd.ms-fontobject",
  ".mp4":  "video/mp4",
  ".webm": "video/webm",
  ".mp3":  "audio/mpeg",
  ".wav":  "audio/wav",
  ".pdf":  "application/pdf",
};

function getMimeType(filename) {
  const ext = (filename || "").toLowerCase().match(/\.[^.]+$/);
  if (ext && MIME_TYPES[ext[0]]) return MIME_TYPES[ext[0]];
  return "application/octet-stream";
}

// Convert a file path like "about.html" or "blog/post-1.html" into a clean URL path.
//   "index.html"          -> "/"
//   "about.html"          -> "/about"
//   "contact.html"        -> "/contact"
//   "blog/post-1.html"    -> "/blog/post-1"
//   "css/style.css"       -> "/css/style.css"   (non-HTML keeps its extension)
//   "js/main.js"          -> "/js/main.js"
//   "images/logo.png"     -> "/images/logo.png"
function filePathToUrlPath(filePath) {
  if (!filePath) return "/";
  // Normalize backslashes
  let p = filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  // index.html (anywhere) becomes the root of its folder
  //   "index.html"        -> "/"
  //   "blog/index.html"   -> "/blog"
  if (p === "index.html") return "/";
  if (p.endsWith("/index.html")) {
    return "/" + p.slice(0, -"/index.html".length);
  }
  // HTML files: strip the .html/.htm extension
  if (p.endsWith(".html")) return "/" + p.slice(0, -5);
  if (p.endsWith(".htm"))  return "/" + p.slice(0, -4);
  // Non-HTML files: keep the path as-is (with leading slash)
  return "/" + p;
}

// Given a `files` object { "index.html": "...", "about.html": "..." }, build
// the pathMap { "/": "index.html", "/about": "about.html", ... }.
// If multiple files would map to the same URL path (e.g. both "index.html"
// and "index.htm" exist), the first one wins and a warning is logged.
function buildPathMap(files) {
  const pathMap = {};
  const seen = {};  // urlPath -> first filePath that claimed it
  const order = Object.keys(files).sort();  // deterministic
  for (const fp of order) {
    const up = filePathToUrlPath(fp);
    if (seen[up]) {
      console.warn("[multipage] Path collision: '" + fp + "' maps to '" + up + "' but '" + seen[up] + "' already claimed it. Skipping '" + fp + "'.");
      continue;
    }
    pathMap[up] = fp;
    seen[up] = fp;
  }
  return pathMap;
}

// Given an incoming request path (e.g. "/about", "/css/style.css", "/"),
// resolve it against the pathMap. Returns the file path or null if not found.
//   "/"              -> "index.html"  (if present)
//   "/about"         -> "about.html"
//   "/about/"        -> "about.html"  (trailing slash tolerated)
//   "/blog/post-1"   -> "blog/post-1.html"
//   "/css/style.css" -> "css/style.css"
//   "/unknown"       -> null
// Also handles directory-index fallback: "/blog/" -> "blog/index.html"
function resolvePath(reqPath, pathMap) {
  if (!reqPath || reqPath === "") reqPath = "/";
  // Strip query string and hash
  let p = reqPath.split("?")[0].split("#")[0];
  // Normalize trailing slash (but keep root "/")
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  // Direct hit
  if (pathMap[p]) return pathMap[p];
  // Trailing-slash variant
  if (p !== "/" && pathMap[p + "/"]) return pathMap[p + "/"];
  // Directory-index fallback: "/blog" -> "blog/index.html" maps to "/blog"
  // (already handled by filePathToUrlPath, but check just in case)
  if (p !== "/" && pathMap[p + "/index"]) return pathMap[p + "/index"];
  // Try with .html extension (in case the user typed "/about" but only
  // "about.html" exists with no extension-stripped mapping — shouldn't happen
  // because buildPathMap already strips .html, but defensive)
  if (pathMap[p + ".html"]) return pathMap[p + ".html"];
  return null;
}

// Quick check: does this `files` object qualify as a multi-page project?
// Returns true only if there are 2+ HTML files. Single HTML file + CSS/JS
// tabs should still go through the existing single-file deploy (mergeFilesToHtml).
function isMultiPageProject(files) {
  if (!files || typeof files !== "object") return false;
  const htmlCount = Object.keys(files).filter(k => k.endsWith(".html") || k.endsWith(".htm")).length;
  return htmlCount >= 2;
}

// Validate a `files` object. Returns { ok: true } or { ok: false, error: "..." }.
// Rules:
//   - Must be a non-empty object
//   - Must contain at least one .html or .htm file
//   - Total size of all file contents must be under 5MB (Firestore doc limit safety)
//   - No file path may contain ".." (path traversal)
//   - No file path may start with "/" (relative paths only)
function validateFiles(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return { ok: false, error: "files must be an object" };
  }
  const keys = Object.keys(files);
  if (keys.length === 0) return { ok: false, error: "files is empty" };
  let hasHtml = false;
  let totalSize = 0;
  for (const k of keys) {
    if (typeof k !== "string" || k.length === 0) return { ok: false, error: "Empty file path" };
    if (k.includes("..")) return { ok: false, error: "Path traversal not allowed: " + k };
    if (k.startsWith("/")) return { ok: false, error: "Absolute paths not allowed: " + k };
    const content = files[k];
    if (typeof content !== "string") return { ok: false, error: "File content must be a string: " + k };
    if (k.endsWith(".html") || k.endsWith(".htm")) hasHtml = true;
    totalSize += content.length;
  }
  if (!hasHtml) return { ok: false, error: "At least one .html file is required" };
  if (totalSize > 5_000_000) return { ok: false, error: "Total project size exceeds 5MB" };
  return { ok: true };
}

module.exports = {
  getMimeType,
  filePathToUrlPath,
  buildPathMap,
  resolvePath,
  isMultiPageProject,
  validateFiles,
};
