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
    const { html, title, ttl, browserId } = req.body || {};
    if (!html || typeof html !== "string") return res.status(400).json({ error: "HTML content required" });
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
      browserId: browserId || "anonymous", createdAt: now, expiresAt,
    });
    const baseUrl = `https://${req.headers.host}`;
    return res.status(200).json({ id, url: `${baseUrl}/site/${id}`, expiresAt });
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
      sites.push({ id: d.id, title: d.title, createdAt: d.createdAt, expiresAt: d.expiresAt });
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
    const { data, filename, mimeType } = req.body || {};
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
    return res.status(200).json({ url: result.secure_url });
  } catch (err) {
    console.error("[media] Error:", err);
    return res.status(500).json({ error: err.message || "Upload failed" });
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
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    const bodyText = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "").trim();
    const hasRootDiv = /<div[^>]+id=["']?(root|app)["']?/i.test(html);
    if (bodyText.length < 100 || (hasRootDiv && bodyText.length < 200)) {
      warning = "This page may require JavaScript to render — the cloned copy might look mostly blank. This is common with React, Vue, and other SPA frameworks.";
    }
  }
  let links = [];
  try {
    const finalHost = new URL(finalUrl).hostname.toLowerCase();
    const selfKey = finalUrl.split("#")[0].replace(/\/$/, "");
    const seen = new Set([selfKey]);
    const linkRegex = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRegex.exec(html)) && links.length < 10) {
      const href = m[1];
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
      let abs;
      try { abs = new URL(href, finalUrl); } catch (e) { continue; }
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      if (abs.hostname.toLowerCase() !== finalHost) continue;
      abs.hash = "";
      const key = abs.href.replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || abs.pathname;
      links.push({ url: abs.href, label });
    }
  } catch (e) {
    console.warn("[clone] Link discovery failed:", e.message);
  }
  return res.status(200).json({ html, warning, links });
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
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(data.html);
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
    const { files, title, ttl, browserId } = req.body || {};

    // Validate the files object
    const validation = multipage.validateFiles(files);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    // Only treat as multi-page if there are 2+ HTML files. If only 1 HTML file
    // + CSS/JS, the frontend should use the existing single-file deploy instead.
    // (We still accept it here as a fallback, but warn.)
    if (!multipage.isMultiPageProject(files)) {
      // Not strictly an error — but flag it so the frontend knows to use single-file deploy
      console.warn("[multi-deploy] Project has only 1 HTML file — should use /api/deploy instead");
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
      files,        // { "index.html": "...", "about.html": "...", ... }
      pathMap,      // { "/": "index.html", "/about": "about.html", ... }
    });

    const baseUrl = `https://${req.headers.host}`;
    return res.status(200).json({
      id,
      url: `${baseUrl}/p/${id}`,
      expiresAt,
      multiPage: true,
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

    res.setHeader("Content-Type", multipage.getMimeType(filePath));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).send(content);
  } catch (err) {
    console.error("[multi-serve] Error:", err);
    return res.status(500).send(renderSiteError("Server error", err.message));
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
  if (route !== "site" && route !== "multi-serve" && isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden. Use a real browser." });
  }

  switch (route) {
    case "deploy":           return handleDeploy(req, res);
    case "sites":            return handleSites(req, res);
    case "media":            return handleMedia(req, res);
    case "clone":            return handleClone(req, res);
    case "save-user":        return handleSaveUser(req, res);
    case "settings":        return handleSettings(req, res);
    case "user-profile":    return handleUserProfile(req, res);
    case "paystack-verify": return handlePaystackVerify(req, res);
    case "site":            return handleSite(req, res);
    case "multi-deploy":    return handleMultiDeploy(req, res);
    case "multi-serve":     return handleMultiServe(req, res);
    default:
      return res.status(404).json({ error: "Unknown route: " + (route || "(missing)") });
  }
};
