// /api/main.js — consolidated endpoint dispatcher
// Handles the following routes via ?route= parameter:
//   deploy, sites, media, clone, save-user, settings, user-profile, paystack-verify, site
//
// vercel.json rewrites:
//   /api/deploy         → /api/main?route=deploy
//   /api/sites          → /api/main?route=sites
//   /api/media          → /api/main?route=media
//   /api/clone          → /api/main?route=clone
//   /api/save-user      → /api/main?route=save-user
//   /api/settings       → /api/main?route=settings
//   /api/user-profile   → /api/main?route=user-profile
//   /api/paystack/verify → /api/main?route=paystack-verify
//   /site/:id           → /api/main?route=site&id=:id
//
// The frontend doesn't need to know this — it still calls /api/deploy etc. and
// Vercel transparently rewrites. The business logic of each route is preserved
// EXACTLY as it was in its own file (just inlined into handlers).
//
// IMPORTANT: this file MUST NOT exceed Vercel's 250KB serverless function bundle
// limit. The handlers are kept compact and share the Firebase init via lib/firebase.

const { getDb } = require("../lib/firebase");
const {
  doc, setDoc, getDoc, getDocs, collection, query, where,
  deleteDoc, updateDoc,
} = require("firebase/firestore");

// ===== Phase 1: Multi-page site support (additive, no impact on existing flows) =====
const multipage = require("../lib/multipage");

// ===== Clone upgrade: asset inlining + smart-scrape + multi-page crawl =====
const cloneHelpers = require("../lib/clone-helpers");

// ===== Custom name (slug) support =====
// Reserved words that can't be used as custom names (would collide with app routes)
const RESERVED_SLUGS = new Set([
  "admin", "api", "settings", "new", "templates", "docs", "pricing", "sites",
  "clipboard", "tools", "media", "changelog", "privacy", "terms", "site", "p",
  "signin", "signup", "save-user", "user-profile", "paystack", "clone", "deploy",
  "ashna-models", "ai-providers", "ai-edit", "serve", "og-image", "multi-deploy",
  "multi-serve", "clone-multi", "media-list", "media-delete", "api-sites",
  "api-deploy", "api-delete", "api-token-create", "api-token-list", "api-token-delete",
  "check-slug", "site-resolve", "site-update-name", "sw.js", "manifest.json",
  "favicon", "favicon.ico", "favicon.png", "icon", "icon.png", "icon-192",
  "icon-512", "apple-touch-icon", "robots", "robots.txt", "svarna-template",
  "index.html", "_next", "auth", "upgrade", "pro", "billing", "account",
]);

// Validate a custom name (slug). Returns { ok: true } or { ok: false, error }.
function validateSlug(slug) {
  if (!slug) return { ok: false, error: "Custom name is required" };
  if (typeof slug !== "string") return { ok: false, error: "Invalid custom name" };
  const lower = slug.toLowerCase().trim();
  if (lower.length < 3) return { ok: false, error: "Custom name must be at least 3 characters" };
  if (lower.length > 30) return { ok: false, error: "Custom name must be 30 characters or fewer" };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(lower)) {
    return { ok: false, error: "Custom name can only contain lowercase letters, numbers, and hyphens (no leading/trailing hyphens)" };
  }
  if (RESERVED_SLUGS.has(lower)) {
    return { ok: false, error: "\"" + lower + "\" is a reserved word — try a different name" };
  }
  return { ok: true, normalized: lower };
}

// Check if a slug is available (not taken by another site, not reserved).
// Returns { available: true } or { available: false, error }.
async function checkSlugAvailability(slug) {
  const validation = validateSlug(slug);
  if (!validation.ok) return { available: false, error: validation.error };
  const lower = validation.normalized;
  const db = getDb();
  // Check if any site already uses this customName
  const q = query(collection(db, "sites"), where("customName", "==", lower));
  const snap = await getDocs(q);
  if (!snap.empty) {
    return { available: false, error: "\"" + lower + "\" is already taken — try a different name" };
  }
  // Also check the projects collection (multi-page sites can have custom names too)
  const q2 = query(collection(db, "projects"), where("customName", "==", lower));
  const snap2 = await getDocs(q2);
  if (!snap2.empty) {
    return { available: false, error: "\"" + lower + "\" is already taken — try a different name" };
  }
  return { available: true };
}

// ===== Shared scraper-blocker (since we can't use Edge Middleware without Next.js) =====
function isScraperUa(ua) {
  if (!ua || ua.length < 20) return true;
  const lower = ua.toLowerCase();
  const patterns = ["wget", "curl", "httrack", "scrapy", "python-requests", "python-httpx",
    "python-urllib", "httpclient", "mechanize", "node-fetch", "got/", "axios/",
    "go-http-client", "okhttp", "spider", "crawler", "archive.org", "ahrefsbot",
    "semrush", "bytespider"];
  return patterns.some(p => lower.includes(p));
}

// ===== Paystack config (read at module load so the route can use it) =====
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";

// ===== Cloudinary config (from old api/media.js) =====
const CLOUDINARY_CLOUD_NAME = "dbmtqgs3v";
const CLOUDINARY_UPLOAD_PRESET = "kayhost";

// ===== Route handlers (inlined from the old /api/*.js files) =====

// --- route=deploy (from old api/deploy.js) ---
async function handleDeploy(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { html, title, ttl, browserId, customName } = req.body || {};
    if (!html || typeof html !== "string") return res.status(400).json({ error: "HTML content required" });
    if (html.length > 500_000) return res.status(413).json({ error: "HTML too large (max 500KB)" });
    const id = Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    let expiresAt = null;
    if (ttl === "1d") expiresAt = now + 86400000;
    else if (ttl === "7d") expiresAt = now + 604800000;
    else if (ttl === "30d") expiresAt = now + 2592000000;

    // --- Custom name (slug) handling ---
    let normalizedCustomName = null;
    if (customName && typeof customName === "string" && customName.trim()) {
      const validation = validateSlug(customName);
      if (!validation.ok) {
        return res.status(400).json({ error: validation.error });
      }
      const availability = await checkSlugAvailability(validation.normalized);
      if (!availability.available) {
        return res.status(409).json({ error: availability.error });
      }
      normalizedCustomName = validation.normalized;
    }

    const db = getDb();
    await setDoc(doc(db, "sites", id), {
      id, html, title: title || "Untitled",
      browserId: browserId || "anonymous", createdAt: now, expiresAt,
      customName: normalizedCustomName,
    });
    const baseUrl = `https://${req.headers.host}`;
    // Return the custom-name URL if set, otherwise the random-ID URL
    const url = normalizedCustomName ? `${baseUrl}/${normalizedCustomName}` : `${baseUrl}/site/${id}`;
    return res.status(200).json({ id, url, expiresAt, customName: normalizedCustomName });
  } catch (err) {
    console.error("[deploy] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to deploy" });
  }
}

// --- route=sites (from old api/sites.js) ---
async function handleSites(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const browserId = req.query.browserId;
    if (!browserId) return res.status(200).json({ sites: [] });
    const db = getDb();
    const q = query(collection(db, "sites"), where("browserId", "==", browserId));
    const snapshot = await getDocs(q);
    const sites = [];
    snapshot.forEach((docSnap) => {
      const d = docSnap.data();
      sites.push({ id: d.id, title: d.title, createdAt: d.createdAt, expiresAt: d.expiresAt, customName: d.customName || null });
    });
    sites.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return res.status(200).json({ sites: sites.slice(0, 50) });
  } catch (err) {
    console.error("[sites] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// --- route=media (from old api/media.js) ---
async function handleMedia(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (CLOUDINARY_CLOUD_NAME === "REPLACE_WITH_YOUR_CLOUD_NAME") {
      return res.status(500).json({ error: "Cloudinary cloud name not set." });
    }
    const { data, filename, mimeType, browserId, uid } = req.body || {};
    if (!data) return res.status(400).json({ error: "No image data" });
    const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
    const formData = new (require("url").URLSearchParams)();
    formData.append("file", data);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    const uploadRes = await fetch(cloudinaryUrl, { method: "POST", body: formData });
    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      return res.status(500).json({ error: `Cloudinary error: ${err}` });
    }
    const result = await uploadRes.json();
    // Phase 2: also persist a record in Firestore `mediaLibrary` collection
    // so the user can browse + copy URLs from the Media section.
    try {
      const db = getDb();
      const mediaId = Math.random().toString(36).slice(2, 10);
      await setDoc(doc(db, "mediaLibrary", mediaId), {
        id: mediaId,
        url: result.secure_url,
        filename: filename || "untitled",
        mimeType: mimeType || "image/*",
        size: result.bytes || 0,
        ownerUid: uid || null,           // null for anonymous
        ownerBrowserId: browserId || "anonymous",
        createdAt: Date.now(),
        publicId: result.public_id || null,  // for Cloudinary delete
      });
    } catch (dbErr) {
      console.warn("[media] Failed to persist media record (upload still succeeded):", dbErr.message);
    }
    return res.status(200).json({ url: result.secure_url, publicId: result.public_id || null });
  } catch (err) {
    console.error("[media] Error:", err);
    return res.status(500).json({ error: err.message || "Upload failed" });
  }
}

// ===== Phase 2: Media Library handlers (additive) =====
// GET  /api/main?route=media-list&browserId=...&uid=...
//   returns: { media: [{ id, url, filename, mimeType, createdAt }, ...] }
async function handleMediaList(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { browserId, uid } = req.query;
    const db = getDb();
    let q;
    if (uid) {
      q = query(collection(db, "mediaLibrary"), where("ownerUid", "==", uid));
    } else {
      q = query(collection(db, "mediaLibrary"), where("ownerBrowserId", "==", browserId || "anonymous"));
    }
    const snap = await getDocs(q);
    const media = snap.docs
      .map(d => d.data())
      .filter(d => d.url)  // safety
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 100)  // cap at 100 most recent
      .map(d => ({
        id: d.id,
        url: d.url,
        filename: d.filename || "untitled",
        mimeType: d.mimeType || "image/*",
        size: d.size || 0,
        createdAt: d.createdAt || 0,
      }));
    return res.status(200).json({ media });
  } catch (err) {
    console.error("[media-list] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to list media" });
  }
}

// POST /api/main?route=media-delete
//   body: { id, browserId, uid }
//   deletes the Firestore record. Does NOT delete from Cloudinary (no API key
//   configured server-side for Cloudinary admin API) — the URL stays alive
//   but disappears from the user's library.
async function handleMediaDelete(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { id, browserId, uid } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const db = getDb();
    const ref = doc(db, "mediaLibrary", id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return res.status(404).json({ error: "Not found" });
    const data = snap.data();
    // Ownership check: only the owner can delete
    if (uid && data.ownerUid !== uid) {
      return res.status(403).json({ error: "Not your media" });
    }
    if (!uid && data.ownerBrowserId !== (browserId || "anonymous")) {
      return res.status(403).json({ error: "Not your media" });
    }
    await deleteDoc(ref);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[media-delete] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to delete" });
  }
}

// --- route=clone (from old api/clone.js) ---
function escapeAttr(s) {
  return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handleClone(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "URL required" });
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch (e) {
    return res.status(400).json({ error: "Invalid URL. Must start with http:// or https://" });
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return res.status(400).json({ error: "Only http:// and https:// URLs are allowed." });
  }
  const hostname = parsedUrl.hostname.toLowerCase();
  const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "metadata.google.internal"];
  for (const h of blockedHosts) {
    if (hostname === h || hostname.endsWith("." + h)) {
      return res.status(403).json({ error: "This URL points to an internal/private address and cannot be cloned." });
    }
  }
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [_, a, b] = ipMatch.map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 127)) {
      return res.status(403).json({ error: "This URL points to a private/internal IP range and cannot be cloned." });
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let fetchRes, finalUrl = url;
  try {
    fetchRes = await fetch(url, { headers: { "User-Agent": "KayhostHTML/1.0" }, redirect: "follow", signal: controller.signal });
    clearTimeout(timeout);
    finalUrl = fetchRes.url || url;
    const finalParsed = new URL(finalUrl);
    const finalHost = finalParsed.hostname.toLowerCase();
    const finalIpMatch = finalHost.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (finalIpMatch) {
      const [_, a, b] = finalIpMatch.map(Number);
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 127)) {
        return res.status(403).json({ error: "This URL redirected to a private/internal address and cannot be cloned." });
      }
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "That site took too long to respond (8s timeout). Try a different URL." });
    }
    return res.status(502).json({ error: "Couldn't fetch that URL. The site may be down or block cloning. (" + (err.message || "unknown error").slice(0, 80) + ")" });
  }
  if (!fetchRes.ok) {
    return res.status(502).json({ error: `The target site returned HTTP ${fetchRes.status}.` });
  }
  const contentLength = parseInt(fetchRes.headers.get("content-length") || "0", 10);
  if (contentLength > 5 * 1024 * 1024) {
    return res.status(413).json({ error: "That page is too large (>5MB). Try a smaller page." });
  }
  let html = await fetchRes.text();
  if (html.length > 5 * 1024 * 1024) {
    return res.status(413).json({ error: "That page is too large (>5MB). Try a smaller page." });
  }
  const baseTag = `<base href="${escapeAttr(finalUrl)}">`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
  } else {
    html = `<!DOCTYPE html><html><head>${baseTag}</head><body>${html}</body></html>`;
  }
  let warning = null;
  // === Part 2: JS-shell detection + Browserless smart-scrape fallback ===
  // If the fetched HTML looks like a JS-rendered shell, try Browserless /smart-scrape
  // to get the rendered HTML. If that succeeds, use the rendered HTML instead.
  // If it fails or times out, fall back to the raw HTML with a warning.
  if (cloneHelpers.looksLikeJsShell(html)) {
    if (process.env.BROWSERLESS_API_KEY) {
      const scraped = await cloneHelpers.smartScrapeRender(finalUrl);
      if (scraped.ok && scraped.html) {
        // Replace the html with the rendered version. Re-inject the <base> tag.
        let renderedHtml = scraped.html;
        if (/<head[^>]*>/i.test(renderedHtml)) {
          renderedHtml = renderedHtml.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
        } else if (/<html[^>]*>/i.test(renderedHtml)) {
          renderedHtml = renderedHtml.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
        } else {
          renderedHtml = `<!DOCTYPE html><html><head>${baseTag}</head><body>${renderedHtml}</body></html>`;
        }
        html = renderedHtml;
        warning = null;  // smart-scrape gave us rendered content, no warning needed
      } else {
        // Smart-scrape failed — keep the raw HTML, warn the user
        warning = "This page uses JavaScript rendering — the clone may be incomplete. (" + (scraped.error || "smart-scrape failed") + ")";
        console.warn("[clone] smart-scrape failed:", scraped.error);
      }
    } else {
      // No BROWSERLESS_API_KEY configured — show the existing warning
      warning = "This page may require JavaScript to render — the cloned copy might look mostly blank. This is common with React, Vue, and other SPA frameworks.";
    }
  } else {
    // Existing warning logic for pages that aren't JS shells but might still have minimal content
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      const bodyText = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "").trim();
      const hasRootDiv = /<div[^>]+id=["']?(root|app)["']?/i.test(html);
      if (bodyText.length < 100 || (hasRootDiv && bodyText.length < 200)) {
        warning = "This page may require JavaScript to render — the cloned copy might look mostly blank. This is common with React, Vue, and other SPA frameworks.";
      }
    }
  }

  // === Part 1: Asset inlining ===
  // Inline linked CSS, JS, and image assets. Stops when the time budget is exhausted.
  // Time budget: 6 seconds (leaves ~2s of the 8s total for the initial fetch above).
  // Note: we measure from NOW (after the fetch), not from the start of the request,
  // so if the fetch took 3s we have 6s for inlining — which is fine because the
  // overall response time will be 9s max (1s over the original 8s, but well under
  // the 60s Vercel function max).
  let inlinedCount = 0, skippedCount = 0, timedOut = false;
  try {
    const result = await cloneHelpers.inlineAssets(html, finalUrl, cloneHelpers.MAX_TOTAL_INLINE_MS);
    html = result.html;
    inlinedCount = result.inlinedCount;
    skippedCount = result.skippedCount;
    timedOut = result.timedOut;
  } catch (e) {
    console.warn("[clone] Asset inlining failed (continuing with un-inlined HTML):", e.message);
  }
  if (timedOut) {
    // Add a soft warning if we hit the time budget
    warning = (warning ? warning + " " : "") + "Some assets were not inlined (time budget exhausted) — they remain as external references.";
  }

  let links = [];
  try {
    links = cloneHelpers.extractSameDomainLinks(html, finalUrl, 10);
  } catch (e) {
    console.warn("[clone] Link discovery failed:", e.message);
  }
  return res.status(200).json({ html, warning, links, inlinedCount, skippedCount });
}

// ===== Part 3: Multi-page clone (SSE — streams progress) =====
// POST /api/clone-multi
//   body: { url, browserId, uid }
// Response: Server-Sent Events stream
//   event: progress  data: {"message": "...", "page": 3, "total": 10}
//   event: done       data: {"projectId": "abc123", "url": "https://host/p/abc123", "pages": [...]}
//   event: error      data: {"error": "..."}
//
// Crawl up to 10 same-domain pages, inline assets on each, store as a multi-page
// project in Firestore `projects` collection. Respects robots.txt.
async function handleCloneMulti(req, res) {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  function sendEvent(event, data) {
    res.write("event: " + event + "\n");
    res.write("data: " + JSON.stringify(data) + "\n\n");
  }

  if (req.method !== "POST") {
    sendEvent("error", { error: "Method not allowed" });
    return res.end();
  }
  const { url, browserId, uid } = req.body || {};
  if (!url) {
    sendEvent("error", { error: "URL required" });
    return res.end();
  }

  // === SSRF checks (same as handleClone) ===
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch (e) {
    sendEvent("error", { error: "Invalid URL. Must start with http:// or https://" });
    return res.end();
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    sendEvent("error", { error: "Only http:// and https:// URLs are allowed." });
    return res.end();
  }
  const hostname = parsedUrl.hostname.toLowerCase();
  const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "metadata.google.internal"];
  for (const h of blockedHosts) {
    if (hostname === h || hostname.endsWith("." + h)) {
      sendEvent("error", { error: "This URL points to an internal/private address and cannot be cloned." });
      return res.end();
    }
  }
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [_, a, b] = ipMatch.map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 127)) {
      sendEvent("error", { error: "This URL points to a private/internal IP range and cannot be cloned." });
      return res.end();
    }
  }

  // === Robots.txt check ===
  sendEvent("progress", { message: "Checking robots.txt…", page: 0, total: 0 });
  const robots = await cloneHelpers.checkRobotsTxt(url);
  if (!robots.allowed) {
    sendEvent("error", { error: "Crawling disallowed by robots.txt: " + robots.reason });
    return res.end();
  }

  // === Fetch the initial page (same logic as handleClone) ===
  sendEvent("progress", { message: "Fetching initial page…", page: 0, total: 0 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let fetchRes, finalUrl = url;
  try {
    fetchRes = await fetch(url, { headers: { "User-Agent": "KayhostHTML/1.0" }, redirect: "follow", signal: controller.signal });
    clearTimeout(timeout);
    finalUrl = fetchRes.url || url;
    const finalParsed = new URL(finalUrl);
    const finalHost = finalParsed.hostname.toLowerCase();
    const finalIpMatch = finalHost.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (finalIpMatch) {
      const [_, a, b] = finalIpMatch.map(Number);
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 127)) {
        sendEvent("error", { error: "This URL redirected to a private/internal address and cannot be cloned." });
        return res.end();
      }
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      sendEvent("error", { error: "That site took too long to respond (8s timeout). Try a different URL." });
    } else {
      sendEvent("error", { error: "Couldn't fetch that URL. (" + (err.message || "unknown error").slice(0, 80) + ")" });
    }
    return res.end();
  }
  if (!fetchRes.ok) {
    sendEvent("error", { error: "The target site returned HTTP " + fetchRes.status + "." });
    return res.end();
  }
  let initialHtml = await fetchRes.text();
  if (initialHtml.length > 5 * 1024 * 1024) {
    sendEvent("error", { error: "That page is too large (>5MB). Try a smaller page." });
    return res.end();
  }

  // === Part 2: smart-scrape fallback for the initial page ===
  let warning = null;
  if (cloneHelpers.looksLikeJsShell(initialHtml) && process.env.BROWSERLESS_API_KEY) {
    sendEvent("progress", { message: "Page looks JS-rendered — using Browserless to get rendered HTML…", page: 0, total: 0 });
    const scraped = await cloneHelpers.smartScrapeRender(finalUrl);
    if (scraped.ok && scraped.html) {
      initialHtml = scraped.html;
    } else {
      warning = "Initial page uses JavaScript rendering — the clone may be incomplete. (" + (scraped.error || "smart-scrape failed") + ")";
    }
  }

  // === Extract same-domain links for crawling ===
  const links = cloneHelpers.extractSameDomainLinks(initialHtml, finalUrl, cloneHelpers.MULTI_PAGE_MAX_PAGES);
  const totalPages = 1 + links.length;  // initial + crawled
  sendEvent("progress", { message: "Found " + links.length + " same-domain link(s) to crawl. Starting…", page: 0, total: totalPages });

  // === Build the files map (start with the initial page) ===
  const files = {};
  const initialFilePath = "index.html";
  // Inline assets on the initial page
  sendEvent("progress", { message: "Inlining assets on initial page…", page: 1, total: totalPages });
  let inlinedInitial;
  try {
    inlinedInitial = await cloneHelpers.inlineAssets(initialHtml, finalUrl, cloneHelpers.MAX_TOTAL_INLINE_MS);
  } catch (e) {
    inlinedInitial = { html: initialHtml, inlinedCount: 0, skippedCount: 0, timedOut: false };
  }
  // Inject <base> tag so any remaining relative URLs still resolve
  const initialBaseTag = '<base href="' + escapeAttr(finalUrl) + '">';
  let initialFinal = inlinedInitial.html;
  if (/<head[^>]*>/i.test(initialFinal)) {
    initialFinal = initialFinal.replace(/<head([^>]*)>/i, "<head$1>" + initialBaseTag);
  }
  files[initialFilePath] = initialFinal;

  // === Crawl each linked page ===
  let crawledCount = 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const pageNum = i + 2;  // 1-indexed, initial was page 1
    sendEvent("progress", {
      message: "Cloning page " + pageNum + " of " + totalPages + ": " + link.label,
      page: pageNum,
      total: totalPages,
      url: link.url,
    });

    // Robots.txt check for each page (in case the site disallows specific paths)
    const pageRobots = await cloneHelpers.checkRobotsTxt(link.url);
    if (!pageRobots.allowed) {
      console.log("[clone-multi] Skipping " + link.url + " (robots.txt: " + pageRobots.reason + ")");
      continue;
    }

    // Fetch the page (with per-page timeout)
    const pageController = new AbortController();
    const pageTimeout = setTimeout(() => pageController.abort(), 8000);
    let pageRes;
    try {
      pageRes = await fetch(link.url, {
        headers: { "User-Agent": "KayhostHTML/1.0 (clone crawler)" },
        redirect: "follow",
        signal: pageController.signal,
      });
      clearTimeout(pageTimeout);
      if (!pageRes.ok) {
        console.warn("[clone-multi] Skipping " + link.url + " (HTTP " + pageRes.status + ")");
        continue;
      }
    } catch (err) {
      clearTimeout(pageTimeout);
      console.warn("[clone-multi] Skipping " + link.url + " (" + (err.message || "fetch failed") + ")");
      continue;
    }
    let pageHtml = await pageRes.text();
    if (pageHtml.length > 5 * 1024 * 1024) continue;

    // smart-scrape fallback for this page too
    if (cloneHelpers.looksLikeJsShell(pageHtml) && process.env.BROWSERLESS_API_KEY) {
      const scraped = await cloneHelpers.smartScrapeRender(link.url);
      if (scraped.ok && scraped.html) {
        pageHtml = scraped.html;
      }
      // If smart-scrape fails, use whatever we got — don't skip
    }

    // Inline assets on this page
    let inlinedPage;
    try {
      inlinedPage = await cloneHelpers.inlineAssets(pageHtml, link.url, cloneHelpers.MAX_TOTAL_INLINE_MS);
    } catch (e) {
      inlinedPage = { html: pageHtml, inlinedCount: 0, skippedCount: 0, timedOut: false };
    }
    // Inject <base> tag
    const pageBaseTag = '<base href="' + escapeAttr(link.url) + '">';
    let pageFinal = inlinedPage.html;
    if (/<head[^>]*>/i.test(pageFinal)) {
      pageFinal = pageFinal.replace(/<head([^>]*)>/i, "<head$1>" + pageBaseTag);
    }

    // Compute the file path for this page
    const filePath = cloneHelpers.urlToFilePath(link.url);
    // Avoid overwriting index.html if the link happened to be the root
    if (filePath === "index.html") continue;
    files[filePath] = pageFinal;
    crawledCount++;
  }

  // === Store as a multi-page project in Firestore ===
  sendEvent("progress", { message: "Storing " + Object.keys(files).length + " pages as a project…", page: totalPages, total: totalPages });
  try {
    const projectId = Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    const db = getDb();
    const pathMap = multipage.buildPathMap(files);
    await setDoc(doc(db, "projects", projectId), {
      id: projectId,
      title: "Cloned from " + hostname,
      browserId: browserId || "anonymous",
      ownerUid: uid || null,
      createdAt: now,
      expiresAt: null,  // multi-page clones don't expire by default
      files,
      pathMap,
      clonedFrom: finalUrl,
    });
    const baseUrl = "https://" + req.headers.host;
    const projectUrl = baseUrl + "/p/" + projectId;
    sendEvent("done", {
      projectId,
      url: projectUrl,
      pages: Object.keys(files).map(function(fp) {
        return { path: fp, url: projectUrl + (pathMap["/" + fp.replace(/\.html$/, "").replace(/index$/, "")] || "") };
      }),
      pageCount: Object.keys(files).length,
      warning,
    });
  } catch (err) {
    console.error("[clone-multi] Storage failed:", err);
    sendEvent("error", { error: "Failed to store the cloned project: " + (err.message || "unknown error") });
  }
  return res.end();
}

// --- route=save-user (from old api/save-user.js) ---
async function handleSaveUser(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { uid, email, displayName, photoURL, provider } = req.body || {};
    if (!uid) return res.status(400).json({ error: "uid required" });
    const db = getDb();
    const normalizedEmail = (email || "").trim().toLowerCase();
    const now = Date.now();
    const existingByUid = await getDoc(doc(db, "users", uid));
    if (existingByUid.exists()) {
      const data = existingByUid.data() || {};
      const patch = {};
      if (displayName && !data.displayName) patch.displayName = displayName;
      if (photoURL && !data.photoURL) patch.photoURL = photoURL;
      if (provider && !data.provider) patch.provider = provider;
      if (normalizedEmail && !data.email) patch.email = normalizedEmail;
      if (Object.keys(patch).length) {
        await setDoc(doc(db, "users", uid), { ...data, ...patch }, { merge: true });
      }
      return res.status(200).json({ success: true, mode: "updated-existing-uid" });
    }
    if (normalizedEmail) {
      const emailQuery = query(collection(db, "users"), where("email", "==", normalizedEmail));
      const emailSnap = await getDocs(emailQuery);
      if (!emailSnap.empty) {
        const matches = [];
        emailSnap.forEach(d => matches.push({ id: d.id, data: d.data() }));
        matches.sort((a, b) => (a.data.createdAt || 0) - (b.data.createdAt || 0));
        const canonical = matches[0];
        const merged = {
          uid: canonical.data.uid || uid,
          email: normalizedEmail,
          displayName: displayName || canonical.data.displayName || canonical.data.email || "",
          photoURL: photoURL || canonical.data.photoURL || "",
          provider: provider || canonical.data.provider || "unknown",
          pro: matches.some(m => m.data.pro) || canonical.data.pro || false,
          suspended: matches.some(m => m.data.suspended) || canonical.data.suspended || false,
          createdAt: canonical.data.createdAt || now,
          lastMergedAt: now,
        };
        await setDoc(doc(db, "users", uid), merged);
        for (const m of matches) {
          if (m.id !== uid) {
            try { await deleteDoc(doc(db, "users", m.id)); } catch (e) {}
          }
        }
        return res.status(200).json({ success: true, mode: "merged-by-email", removedDuplicates: matches.length });
      }
    }
    await setDoc(doc(db, "users", uid), {
      uid, email: normalizedEmail, displayName: displayName || "",
      photoURL: photoURL || "", provider: provider || "unknown",
      createdAt: now, pro: false, suspended: false,
    });
    return res.status(200).json({ success: true, mode: "created-new" });
  } catch (err) {
    console.error("[save-user] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// --- route=settings (from old api/settings.js) ---
async function handleSettings(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  let db;
  try { db = getDb(); } catch (e) { return res.status(200).json({ chatWidget: "" }); }
  try {
    let chatWidget = "";
    try {
      const snap = await getDoc(doc(db, "settings", "chatWidget"));
      if (snap.exists()) {
        const data = snap.data() || {};
        chatWidget = typeof data.value === "string" ? data.value : "";
      }
    } catch (e) {}
    return res.status(200).json({ chatWidget });
  } catch (err) {
    console.error("[settings] Error:", err);
    return res.status(200).json({ chatWidget: "" });
  }
}

// --- route=user-profile (from old api/user-profile.js) ---
async function handleUserProfile(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  let db;
  try { db = getDb(); } catch (e) { return res.status(200).json({ user: null }); }
  try {
    const email = (req.query.email || "").trim().toLowerCase();
    const uid = (req.query.uid || "").trim();
    if (!email && !uid) return res.status(400).json({ error: "email or uid required" });
    let userDoc = null;
    if (uid) {
      try {
        const snap = await getDoc(doc(db, "users", uid));
        if (snap.exists()) userDoc = { uid: snap.id, ...snap.data() };
      } catch (e) {}
    }
    if (!userDoc && email) {
      try {
        const emailQuery = query(collection(db, "users"), where("email", "==", email));
        const emailSnap = await getDocs(emailQuery);
        if (!emailSnap.empty) {
          emailSnap.forEach(d => { if (!userDoc) userDoc = { uid: d.id, ...d.data() }; });
        }
      } catch (e) {}
    }
    if (!userDoc) return res.status(200).json({ user: null });
    const safeUser = {
      uid: userDoc.uid,
      email: userDoc.email || "",
      displayName: userDoc.displayName || "",
      photoURL: userDoc.photoURL || "",
      provider: userDoc.provider || "unknown",
      pro: !!userDoc.pro,
      suspended: !!userDoc.suspended,
      createdAt: userDoc.createdAt || null,
    };
    return res.status(200).json({ user: safeUser });
  } catch (err) {
    console.error("[user-profile] Error:", err);
    return res.status(200).json({ user: null });
  }
}

// --- route=paystack-verify (from old api/paystack-verify.js) ---
async function handlePaystackVerify(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "Payment verification not configured. Set PAYSTACK_SECRET_KEY env var." });
    }
    const { reference, email: userEmail } = req.body || {};
    if (!reference) return res.status(400).json({ error: "Payment reference required." });
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { method: "GET", headers: { "Authorization": `Bearer ${PAYSTACK_SECRET_KEY}`, "Cache-Control": "no-cache" } }
    );
    if (!verifyRes.ok) {
      console.error("[paystack-verify] Paystack returned HTTP", verifyRes.status);
      return res.status(502).json({ error: "Couldn't verify payment with Paystack. Please try again or contact support." });
    }
    const verifyData = await verifyRes.json();
    if (!verifyData.status) {
      return res.status(400).json({ error: verifyData.message || "Payment verification failed." });
    }
    const tx = verifyData.data || {};
    if (tx.status !== "success") {
      return res.status(400).json({ error: "Payment was not completed successfully. Status: " + (tx.status || "unknown"), status: tx.status });
    }
    const expectedKobo = 1_000_000;
    const actualKobo = Number(tx.amount) || 0;
    if (actualKobo < expectedKobo - 500) {
      console.warn("[paystack-verify] Amount mismatch — expected", expectedKobo, "got", actualKobo);
      return res.status(400).json({ error: `Payment amount incorrect. Expected ₦10,000, got ₦${(actualKobo / 100).toLocaleString()}. Contact support.` });
    }
    const txEmail = (tx.customer && tx.customer.email || "").toLowerCase();
    const expectedEmail = (userEmail || "").toLowerCase();
    if (!txEmail || !expectedEmail || txEmail !== expectedEmail) {
      console.warn("[paystack-verify] Email mismatch — tx:", txEmail, "expected:", expectedEmail);
      return res.status(400).json({ error: "Payment email doesn't match your account email. Please pay with the same email you signed in with." });
    }
    const db = getDb();
    const emailQuery = query(collection(db, "users"), where("email", "==", txEmail));
    const emailSnap = await getDocs(emailQuery);
    if (emailSnap.empty) {
      return res.status(404).json({ error: "Account not found. Please sign in at least once before paying." });
    }
    const batch = [];
    emailSnap.forEach(d => batch.push(d.id));
    const now = Date.now();
    for (const uid of batch) {
      try {
        await updateDoc(doc(db, "users", uid), {
          pro: true, proSetAt: now, proSetBy: "paystack",
          proPaymentRef: reference, proPaymentAmount: actualKobo, proPaymentDate: now,
        });
      } catch (e) {}
    }
    try {
      await setDoc(doc(db, "payments", reference), {
        reference, email: txEmail, amount: actualKobo, currency: tx.currency || "NGN",
        status: tx.status, channel: tx.channel, paidAt: now,
        customerCode: tx.customer && tx.customer.customer_code, proUidsMarked: batch,
      });
    } catch (e) {}
    return res.status(200).json({
      success: true,
      message: "Payment verified. Your account is now Pro! Refresh the page to access Pro features.",
      markedUids: batch.length,
    });
  } catch (err) {
    console.error("[paystack-verify] Error:", err);
    return res.status(500).json({ error: "Payment verification failed: " + (err.message || "unknown error") });
  }
}

// --- route=site (from old api/site/[id].js — serves deployed site HTML) ---
function siteEsc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function renderSiteError(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${siteEsc(title)} — Kayhost</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#08080C;color:#F5F5FA;display:grid;place-items:center;min-height:100vh;padding:24px}.card{max-width:420px;text-align:center;padding:40px 32px;background:rgba(255,255,255,0.03);border:1px solid rgba(192,132,252,0.25);border-radius:20px}.ico{width:48px;height:48px;border-radius:12px;background:rgba(192,132,252,0.12);display:grid;place-items:center;margin:0 auto 16px;color:#C084FC;font-size:24px}h1{font-size:22px;margin-bottom:8px;font-family:system-ui}p{color:#8B8B9A;font-size:14px;line-height:1.5}a{display:inline-block;margin-top:20px;color:#C084FC;text-decoration:none;font-weight:600}</style></head><body><div class="card"><div class="ico">⚠</div><h1>${siteEsc(title)}</h1><p>${siteEsc(message)}</p><a href="/">Go to Kayhost</a></div></body></html>`;
}
function renderSiteExpired(title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Expired — ${siteEsc(title)}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#08080C;color:#F5F5FA;display:grid;place-items:center;min-height:100vh;padding:24px}.card{max-width:420px;text-align:center;padding:40px 32px;background:rgba(255,255,255,0.03);border:1px solid rgba(245,158,11,0.2);border-radius:20px}.ico{width:48px;height:48px;border-radius:12px;background:rgba(245,158,11,0.12);display:grid;place-items:center;margin:0 auto 16px;color:#f59e0b;font-size:24px}h1{font-size:22px;margin-bottom:8px;font-family:system-ui}p{color:#8B8B9A;font-size:14px;line-height:1.5}a{display:inline-block;margin-top:20px;color:#C084FC;text-decoration:none;font-weight:600}</style></head><body><div class="card"><div class="ico">⏰</div><h1>This link has expired</h1><p>"${siteEsc(title)}" was set to expire and is no longer available.</p><a href="/">Create a new page on Kayhost</a></div></body></html>`;
}

// ===== Phase 5: OG image preview injection (additive) =====
// Injects Open Graph meta tags into served HTML so WhatsApp/Twitter/etc.
// show a nice preview card when a Kayhost link is shared.
//
// Strategy:
//   1. Extract <title> from the HTML (or use the site's stored title)
//   2. Extract <meta name="description"> or first <p> for og:description
//   3. Inject og:title, og:description, og:image, og:url, twitter:card meta tags
//   4. og:image points to a dynamic branded SVG generated by /api/og-image?title=...
//
// If the HTML already has og:title / og:image, we DO NOT override them — respect
// the author's explicit choice.
function injectOgMeta(html, siteTitle, siteUrl) {
  if (!html || typeof html !== "string") return html;
  // Don't double-inject if the author already has og:title
  if (/<meta\s+property=["']og:title["']/i.test(html)) return html;

  // Extract <title>...</title> for og:title
  let title = siteTitle || "Untitled";
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch && titleMatch[1].trim()) title = titleMatch[1].trim();

  // Extract description: <meta name="description" content="..."> or first <p>
  let description = "Built with Kayhost HTML — paste, deploy, share.";
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  if (descMatch && descMatch[1].trim()) {
    description = descMatch[1].trim().slice(0, 160);
  } else {
    const pMatch = html.match(/<p[^>]*>([^<]+)<\/p>/i);
    if (pMatch && pMatch[1].trim()) {
      description = pMatch[1].trim().replace(/\s+/g, " ").slice(0, 160);
    }
  }

  const encodedTitle = encodeURIComponent(title);
  const ogImageUrl = `https://${req_headers_host()}/api/og-image?title=${encodedTitle}`;

  const ogTags = [
    '<meta property="og:title" content="' + escapeAttr(title) + '" />',
    '<meta property="og:description" content="' + escapeAttr(description) + '" />',
    '<meta property="og:image" content="' + ogImageUrl + '" />',
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta property="og:url" content="' + escapeAttr(siteUrl || "") + '" />',
    '<meta property="og:type" content="website" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    '<meta name="twitter:title" content="' + escapeAttr(title) + '" />',
    '<meta name="twitter:description" content="' + escapeAttr(description) + '" />',
    '<meta name="twitter:image" content="' + ogImageUrl + '" />',
  ].join("\n    ");

  // Inject into <head> if present, otherwise prepend
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, "<head$1>\n    " + ogTags + "\n");
  }
  return "<head>\n    " + ogTags + "\n</head>\n" + html;
}

// Helper to get req.headers.host safely (used by injectOgMeta)
function req_headers_host() {
  return process.env.VERCEL_URL || "kayhosthtml.zone.id";
}

// ===== Phase 5: Dynamic OG image generator =====
// GET /api/main?route=og-image&title=...
// Returns a 1200x630 SVG image with the Kayhost brand + the site title.
// SVG is used because it's tiny (no image processing libraries needed)
// and supported by most modern crawlers. For crawlers that need PNG/JPG,
// a future phase can use a serverless image generator.
async function handleOgImage(req, res) {
  try {
    const title = (req.query.title || "Untitled").slice(0, 80);
    const subtitle = "Built with Kayhost HTML";
    // Escape XML special chars
    const escTitle = title.replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
    const escSubtitle = subtitle.replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0a0f"/>
      <stop offset="1" stop-color="#1a0006"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e11d48"/>
      <stop offset="1" stop-color="#7f1d1d"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="8" fill="url(#accent)"/>
  <circle cx="100" cy="100" r="40" fill="url(#accent)"/>
  <text x="100" y="115" font-family="system-ui, -apple-system, sans-serif" font-size="48" font-weight="800" fill="#fff" text-anchor="middle">K</text>
  <text x="160" y="115" font-family="system-ui, -apple-system, sans-serif" font-size="36" font-weight="700" fill="#f4f4f8">Kayhost HTML</text>
  <text x="100" y="320" font-family="system-ui, -apple-system, sans-serif" font-size="64" font-weight="800" fill="#f4f4f8">${escTitle}</text>
  <text x="100" y="380" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="500" fill="#b9b9c9">${escSubtitle}</text>
  <text x="100" y="560" font-family="system-ui, -apple-system, sans-serif" font-size="20" fill="#7d7d92">kayhosthtml.zone.id</text>
</svg>`;

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).send(svg);
  } catch (err) {
    console.error("[og-image] Error:", err);
    return res.status(500).send("OG image error");
  }
}

async function handleSite(req, res) {
  // NOTE: NO scraper-blocker on this route — we WANT social-media crawlers (WhatsApp, Facebook, etc.)
  // to be able to fetch the deployed HTML so link previews work.
  try {
    const id = req.query.id || (req.url.split("/site/")[1] || "").split("/")[0] || "";
    if (!id) return res.status(404).send(renderSiteError("No site ID", "This link is missing a site ID."));
    const db = getDb();
    const snap = await getDoc(doc(db, "sites", id));
    if (!snap.exists()) return res.status(404).send(renderSiteError("Not found", "This link doesn't exist or has been deleted."));
    const data = snap.data();
    if (data.expiresAt && Date.now() > data.expiresAt) {
      return res.status(410).send(renderSiteExpired(data.title || "Untitled"));
    }
    // Phase 5: inject OG meta tags for social-media link previews
    const siteUrl = `https://${req.headers.host}/site/${id}`;
    const htmlWithOg = injectOgMeta(data.html, data.title || "Untitled", siteUrl);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(htmlWithOg);
  } catch (err) {
    console.error("[site] Error:", err);
    return res.status(500).send(renderSiteError("Server error", err.message));
  }
}

// ===== Phase 1: Multi-page deploy (additive — only used when frontend sends `files`) =====
// POST /api/multi-deploy
//   body: { files: { "index.html": "...", "about.html": "...", "css/style.css": "..." },
//           title, ttl, browserId }
//   returns: { id, url: "https://host/p/<id>", expiresAt }
//
// Stores in Firestore collection `projects` — completely separate from `sites`.
// The existing single-file /api/deploy route is untouched.
async function handleMultiDeploy(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { files, title, ttl, browserId, customName } = req.body || {};

    // Validate the files object
    const validation = multipage.validateFiles(files);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    // Only treat as multi-page if there are 2+ HTML files.
    if (!multipage.isMultiPageProject(files)) {
      console.warn("[multi-deploy] Project has only 1 HTML file — should use /api/deploy instead");
    }

    // --- Custom name (slug) handling ---
    let normalizedCustomName = null;
    if (customName && typeof customName === "string" && customName.trim()) {
      const slugValidation = validateSlug(customName);
      if (!slugValidation.ok) {
        return res.status(400).json({ error: slugValidation.error });
      }
      const availability = await checkSlugAvailability(slugValidation.normalized);
      if (!availability.available) {
        return res.status(409).json({ error: availability.error });
      }
      normalizedCustomName = slugValidation.normalized;
    }

    // Build the path map
    const pathMap = multipage.buildPathMap(files);

    // Generate ID and compute expiry
    const id = Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    let expiresAt = null;
    if (ttl === "1d") expiresAt = now + 86400000;
    else if (ttl === "7d") expiresAt = now + 604800000;
    else if (ttl === "30d") expiresAt = now + 2592000000;

    const db = getDb();
    await setDoc(doc(db, "projects", id), {
      id,
      title: title || "Untitled",
      browserId: browserId || "anonymous",
      createdAt: now,
      expiresAt,
      files,
      pathMap,
      customName: normalizedCustomName,
    });

    const baseUrl = `https://${req.headers.host}`;
    // For multi-page with custom name, the URL is /<custom-name> (which resolves to the project's index)
    // For multi-page without custom name, the URL is /p/<id>
    const url = normalizedCustomName ? `${baseUrl}/${normalizedCustomName}` : `${baseUrl}/p/${id}`;
    return res.status(200).json({
      id,
      url,
      expiresAt,
      multiPage: true,
      customName: normalizedCustomName,
    });
  } catch (err) {
    console.error("[multi-deploy] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to deploy multi-page project" });
  }
}

// ===== Phase 1: Multi-page serve (additive — only handles /p/:id/* routes) =====
// GET /p/:id           -> serves the project's index.html
// GET /p/:id/about     -> serves about.html (via pathMap)
// GET /p/:id/css/x.css -> serves css/x.css
//
// The route is registered in vercel.json as a rewrite to /api/main?route=multi-serve&id=...&path=...
async function handleMultiServe(req, res) {
  // NO scraper-blocker on this route — same as route=site, we want social
  // media crawlers to be able to fetch the HTML for link previews.
  try {
    // Extract project ID and path from the URL.
    // /p/abc123/about  ->  id=abc123, path=/about
    // /p/abc123/        ->  id=abc123, path=/
    // /p/abc123         ->  id=abc123, path=/
    const url = req.url || "";
    const afterP = url.split("/p/")[1] || "";
    const parts = afterP.split("?")[0].split("/");
    const id = parts[0] || req.query.id || "";
    let path = "/" + parts.slice(1).join("/");
    if (path === "/") path = "/";
    // Re-normalize empty path to "/"
    if (!path || path === "") path = "/";

    if (!id) {
      return res.status(404).send(renderSiteError("No project ID", "This link is missing a project ID."));
    }

    const db = getDb();
    const snap = await getDoc(doc(db, "projects", id));
    if (!snap.exists()) {
      return res.status(404).send(renderSiteError("Not found", "This project doesn't exist or has been deleted."));
    }
    const data = snap.data();
    if (data.expiresAt && Date.now() > data.expiresAt) {
      return res.status(410).send(renderSiteExpired(data.title || "Untitled"));
    }

    const pathMap = data.pathMap || {};
    const files = data.files || {};
    const filePath = multipage.resolvePath(path, pathMap);
    if (!filePath) {
      return res.status(404).send(renderSiteError("Not found", "The page '" + path + "' doesn't exist in this project."));
    }
    const content = files[filePath];
    if (content === undefined) {
      return res.status(404).send(renderSiteError("Not found", "File '" + filePath + "' is missing from this project."));
    }

    // Phase 5: inject OG meta tags for HTML files (skip CSS/JS/images)
    const mime = multipage.getMimeType(filePath);
    let output = content;
    if (mime === "text/html; charset=utf-8") {
      const projectUrl = `https://${req.headers.host}/p/${id}`;
      output = injectOgMeta(content, data.title || "Untitled", projectUrl);
    }

    res.setHeader("Content-Type", mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).send(output);
  } catch (err) {
    console.error("[multi-serve] Error:", err);
    return res.status(500).send(renderSiteError("Server error", err.message));
  }
}

// ===== Phase 6: REST API with Bearer tokens (additive) =====
// Endpoints for programmatic access (similar to htmlhost.co):
//   POST /api/main?route=api-token-create   — create a new API token for the user
//   GET  /api/main?route=api-token-list     — list the user's tokens (masked)
//   POST /api/main?route=api-token-delete   — delete a token
//   GET  /api/main?route=api-sites          — list the user's sites (Bearer auth)
//   POST /api/main?route=api-deploy         — deploy a site (Bearer auth)
//   POST /api/main?route=api-delete         — delete a site (Bearer auth)
//
// Tokens are hashed with SHA-256 and stored in Firestore `apiTokens` collection.
// The plain token is only shown ONCE at creation time.

const crypto = require("crypto");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateToken() {
  // kayh_<32 random hex chars>
  return "kayh_" + crypto.randomBytes(16).toString("hex");
}

// Verify a Bearer token. Returns { uid } on success, null on failure.
async function verifyApiToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token || !token.startsWith("kayh_")) return null;
  const hashed = hashToken(token);
  const db = getDb();
  // Look up by hash
  const q = query(collection(db, "apiTokens"), where("hash", "==", hashed));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const doc = snap.docs[0].data();
  return { uid: doc.uid, tokenId: doc.id, label: doc.label || "API Token" };
}

// POST /api/main?route=api-token-create
//   body: { uid, label }   (uid from the frontend's verified Firebase session)
//   returns: { token: "kayh_...", id, label, createdAt }
//   NOTE: the token is only shown THIS ONE TIME. The DB stores only the hash.
async function handleApiTokenCreate(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { uid, label } = req.body || {};
    if (!uid) return res.status(400).json({ error: "uid required" });
    const token = generateToken();
    const hashed = hashToken(token);
    const id = Math.random().toString(36).slice(2, 12);
    const db = getDb();
    await setDoc(doc(db, "apiTokens", id), {
      id,
      uid,
      hash: hashed,
      label: (label || "API Token").slice(0, 50),
      createdAt: Date.now(),
      lastUsedAt: null,
    });
    return res.status(200).json({ token, id, label: label || "API Token", createdAt: Date.now() });
  } catch (err) {
    console.error("[api-token-create] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to create token" });
  }
}

// GET /api/main?route=api-token-list&uid=...
//   returns: { tokens: [{ id, label, createdAt, lastUsedAt }, ...] }
//   NOTE: never returns the actual token or hash
async function handleApiTokenList(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: "uid required" });
    const db = getDb();
    const q = query(collection(db, "apiTokens"), where("uid", "==", uid));
    const snap = await getDocs(q);
    const tokens = snap.docs
      .map(d => d.data())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(d => ({ id: d.id, label: d.label || "API Token", createdAt: d.createdAt || 0, lastUsedAt: d.lastUsedAt || null }));
    return res.status(200).json({ tokens });
  } catch (err) {
    console.error("[api-token-list] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to list tokens" });
  }
}

// POST /api/main?route=api-token-delete
//   body: { id, uid }
async function handleApiTokenDelete(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { id, uid } = req.body || {};
    if (!id || !uid) return res.status(400).json({ error: "id and uid required" });
    const db = getDb();
    const ref = doc(db, "apiTokens", id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return res.status(404).json({ error: "Token not found" });
    if (snap.data().uid !== uid) return res.status(403).json({ error: "Not your token" });
    await deleteDoc(ref);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[api-token-delete] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to delete token" });
  }
}

// GET /api/main?route=api-sites   (Bearer auth)
//   returns: { sites: [{ id, url, title, createdAt, expiresAt }, ...] }
async function handleApiSites(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const authInfo = await verifyApiToken(req);
    if (!authInfo) return res.status(401).json({ error: "Invalid or missing API token" });
    const db = getDb();
    // List sites owned by this user (by browserId OR by uid).
    // Since the REST API uses uid-based tokens, we look up sites where
    // browserId matches the uid (frontend stores browserId as uid when signed in).
    const q1 = query(collection(db, "sites"), where("browserId", "==", authInfo.uid));
    const snap = await getDocs(q1);
    const baseUrl = `https://${req.headers.host}`;
    const sites = snap.docs
      .map(d => d.data())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 100)
      .map(d => ({
        id: d.id,
        url: `${baseUrl}/site/${d.id}`,
        title: d.title || "Untitled",
        createdAt: d.createdAt || 0,
        expiresAt: d.expiresAt || null,
      }));
    // Update lastUsedAt on the token (best-effort)
    try {
      await setDoc(doc(db, "apiTokens", authInfo.tokenId), { lastUsedAt: Date.now() }, { merge: true });
    } catch (e) {}
    return res.status(200).json({ sites });
  } catch (err) {
    console.error("[api-sites] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to list sites" });
  }
}

// POST /api/main?route=api-deploy   (Bearer auth)
//   body: { html, title, ttl }
//   returns: { id, url, expiresAt }
async function handleApiDeploy(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const authInfo = await verifyApiToken(req);
    if (!authInfo) return res.status(401).json({ error: "Invalid or missing API token" });
    const { html, title, ttl } = req.body || {};
    if (!html || typeof html !== "string") return res.status(400).json({ error: "html required" });
    if (html.length > 500_000) return res.status(413).json({ error: "HTML too large (max 500KB)" });
    const id = Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    let expiresAt = null;
    if (ttl === "1d") expiresAt = now + 86400000;
    else if (ttl === "7d") expiresAt = now + 604800000;
    else if (ttl === "30d") expiresAt = now + 2592000000;
    const db = getDb();
    await setDoc(doc(db, "sites", id), {
      id, html, title: title || "Untitled",
      browserId: authInfo.uid,  // tie to the token owner
      createdAt: now, expiresAt,
    });
    const baseUrl = `https://${req.headers.host}`;
    try {
      await setDoc(doc(db, "apiTokens", authInfo.tokenId), { lastUsedAt: Date.now() }, { merge: true });
    } catch (e) {}
    return res.status(200).json({ id, url: `${baseUrl}/site/${id}`, expiresAt });
  } catch (err) {
    console.error("[api-deploy] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to deploy" });
  }
}

// POST /api/main?route=api-delete   (Bearer auth)
//   body: { id }
async function handleApiDelete(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const authInfo = await verifyApiToken(req);
    if (!authInfo) return res.status(401).json({ error: "Invalid or missing API token" });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const db = getDb();
    const ref = doc(db, "sites", id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return res.status(404).json({ error: "Site not found" });
    if (snap.data().browserId !== authInfo.uid) {
      return res.status(403).json({ error: "Not your site" });
    }
    await deleteDoc(ref);
    try {
      await setDoc(doc(db, "apiTokens", authInfo.tokenId), { lastUsedAt: Date.now() }, { merge: true });
    } catch (e) {}
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[api-delete] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to delete" });
  }
}

// ===== Custom name (slug) handlers =====
// GET /api/check-slug?slug=akaytech
//   Returns { available: true } or { available: false, error }
async function handleCheckSlug(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const slug = req.query.slug;
    if (!slug) return res.status(200).json({ available: false, error: "Enter a custom name to check" });
    const result = await checkSlugAvailability(slug);
    return res.status(200).json(result);
  } catch (err) {
    console.error("[check-slug] Error:", err);
    return res.status(500).json({ available: false, error: "Couldn't check availability" });
  }
}

// GET /api/site-resolve?slug=akaytech
//   Resolves a custom-name slug to its site HTML (single-page) or project (multi-page).
//   Used by the /:slug rewrite in vercel.json.
//   If the slug is reserved or not found, serves the SPA HTML (so the SPA router takes over).
async function handleSiteResolve(req, res) {
  // NO scraper-blocker — social media crawlers need to fetch this for link previews
  try {
    const slug = (req.query.slug || "").toLowerCase().trim();
    if (!slug) {
      // No slug — serve the SPA
      return serveSpa(req, res);
    }

    // Check reserved words — serve the SPA so the app's own routes work
    if (RESERVED_SLUGS.has(slug)) {
      return serveSpa(req, res);
    }

    const db = getDb();

    // 1. Try the sites collection (single-page)
    const siteQuery = query(collection(db, "sites"), where("customName", "==", slug));
    const siteSnap = await getDocs(siteQuery);
    if (!siteSnap.empty) {
      const siteData = siteSnap.docs[0].data();
      if (siteData.expiresAt && Date.now() > siteData.expiresAt) {
        return res.status(410).send(renderSiteExpired(siteData.title || "Untitled"));
      }
      // Inject OG meta + serve
      const siteUrl = `https://${req.headers.host}/${slug}`;
      const htmlWithOg = injectOgMeta(siteData.html, siteData.title || "Untitled", siteUrl);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).send(htmlWithOg);
    }

    // 2. Try the projects collection (multi-page)
    const projectQuery = query(collection(db, "projects"), where("customName", "==", slug));
    const projectSnap = await getDocs(projectQuery);
    if (!projectSnap.empty) {
      const projectData = projectSnap.docs[0].data();
      if (projectData.expiresAt && Date.now() > projectData.expiresAt) {
        return res.status(410).send(renderSiteExpired(projectData.title || "Untitled"));
      }
      // Serve the project's index.html (first file or "index.html")
      const files = projectData.files || {};
      const pathMap = projectData.pathMap || {};
      const indexPath = pathMap["/"] || "index.html";
      const content = files[indexPath];
      if (content) {
        const projectUrl = `https://${req.headers.host}/${slug}`;
        const htmlWithOg = injectOgMeta(content, projectData.title || "Untitled", projectUrl);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.status(200).send(htmlWithOg);
      }
    }

    // 3. Not found — serve the SPA (so the app shows its normal 404 / home view)
    return serveSpa(req, res);
  } catch (err) {
    console.error("[site-resolve] Error:", err);
    return serveSpa(req, res);
  }
}

// Serve the SPA HTML by fetching /index.html from the same origin.
// Used as a fallback when a slug is reserved or not found.
async function serveSpa(req, res) {
  try {
    const baseUrl = `https://${req.headers.host}`;
    const spaRes = await fetch(baseUrl + "/index.html");
    if (spaRes.ok) {
      const html = await spaRes.text();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(html);
    }
  } catch (e) {
    console.warn("[site-resolve] Failed to fetch SPA:", e.message);
  }
  // Ultimate fallback — minimal HTML that redirects to root
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"></head><body></body></html>');
}

// POST /api/site-update-name
//   body: { id, customName, browserId }
//   Sets or removes the custom name on an existing site.
//   If customName is null/empty, removes the custom name.
async function handleSiteUpdateName(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { id, customName, browserId } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const db = getDb();
    const ref = doc(db, "sites", id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return res.status(404).json({ error: "Site not found" });
    const data = snap.data();
    // Ownership check: only the owner can change the name
    if (data.browserId !== (browserId || "anonymous")) {
      return res.status(403).json({ error: "Not your site" });
    }

    let normalizedCustomName = null;
    if (customName && typeof customName === "string" && customName.trim()) {
      const validation = validateSlug(customName);
      if (!validation.ok) return res.status(400).json({ error: validation.error });
      // Check availability — but allow keeping the SAME name (no conflict with self)
      if (data.customName !== validation.normalized) {
        const availability = await checkSlugAvailability(validation.normalized);
        if (!availability.available) {
          return res.status(409).json({ error: availability.error });
        }
      }
      normalizedCustomName = validation.normalized;
    }

    await setDoc(ref, { customName: normalizedCustomName }, { merge: true });
    const baseUrl = `https://${req.headers.host}`;
    const url = normalizedCustomName ? `${baseUrl}/${normalizedCustomName}` : `${baseUrl}/site/${id}`;
    return res.status(200).json({ ok: true, customName: normalizedCustomName, url });
  } catch (err) {
    console.error("[site-update-name] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to update name" });
  }
}

// ===== Dispatcher =====
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Block scrapers on every route EXCEPT route=site AND route=multi-serve
  // (both serve user-generated pages and need to be fetchable by
  // WhatsApp/Facebook/etc. for link previews)
  const route = req.query.route || "";
  if (route !== "site" && route !== "multi-serve" && route !== "site-resolve" && isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden. Use a real browser." });
  }

  switch (route) {
    case "deploy":           return handleDeploy(req, res);
    case "sites":            return handleSites(req, res);
    case "media":            return handleMedia(req, res);
    case "media-list":       return handleMediaList(req, res);
    case "media-delete":     return handleMediaDelete(req, res);
    case "clone":            return handleClone(req, res);
    case "clone-multi":      return handleCloneMulti(req, res);
    case "save-user":        return handleSaveUser(req, res);
    case "settings":        return handleSettings(req, res);
    case "user-profile":    return handleUserProfile(req, res);
    case "paystack-verify": return handlePaystackVerify(req, res);
    case "site":            return handleSite(req, res);
    case "multi-deploy":    return handleMultiDeploy(req, res);
    case "multi-serve":     return handleMultiServe(req, res);
    case "og-image":        return handleOgImage(req, res);
    case "check-slug":      return handleCheckSlug(req, res);
    case "site-resolve":    return handleSiteResolve(req, res);
    case "site-update-name":return handleSiteUpdateName(req, res);
    case "api-token-create":return handleApiTokenCreate(req, res);
    case "api-token-list":  return handleApiTokenList(req, res);
    case "api-token-delete":return handleApiTokenDelete(req, res);
    case "api-sites":       return handleApiSites(req, res);
    case "api-deploy":      return handleApiDeploy(req, res);
    case "api-delete":      return handleApiDelete(req, res);
    default:
      return res.status(404).json({ error: "Unknown route: " + (route || "(missing)") });
  }
};
