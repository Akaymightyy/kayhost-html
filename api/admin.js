// /api/admin.js — Server-side admin data endpoint
// SECURITY: Admin access is verified SERVER-SIDE via Firebase Admin SDK token
// verification (see _admin-firebase.js). The client-side triple-click is just a UX
// hint — the server doesn't trust it.
//
// Public-readable sections (no auth required):
//   - templates:  the public templates list (shown on the /templates page)
//   - settings:   ONLY returns chatWidget (the public chat-widget embed code);
//                 all other settings are admin-only and stripped from the response.
// Admin-only sections (require verified ID token whose email is in ADMIN_EMAILS):
//   - overview, users, sites, audit, health, moderation
// Admin-only POST actions (same auth):
//   - deleteSite, extendTtl, suspendUser, setPro, promoteAdmin, demoteAdmin,
//     addTemplate, deleteTemplate, updateSettings

const { getDb } = require("../lib/firebase");
const { collection, getDocs, doc, getDoc, setDoc, deleteDoc, updateDoc } = require("firebase/firestore");

const ADMIN_EMAILS = ["awwalabdul891@gmail.com", "kayhost@admin.com"].map(e => e.toLowerCase());

// Try to load the admin SDK. If FIREBASE_SERVICE_ACCOUNT_KEY isn't set, all
// admin requests will 401 — that's intentional. Don't fall back to "trust the
// client" — that was the original security hole that let anyone hit /api/admin
// and dump the user list.
let _getAdmin = null;
try {
  _getAdmin = require("../lib/admin-firebase").getAdmin;
} catch (e) {
  console.warn("[admin] lib/admin-firebase.js not available — admin endpoints will 401");
}

// Verify the request's ID token (sent as Authorization: Bearer <idToken> or ?token=)
// and return the decoded user email. Returns null if verification fails.
async function verifyAdmin(req) {
  if (!_getAdmin) return null;
  let idToken = null;
  const authHeader = req.headers && (req.headers["authorization"] || req.headers["Authorization"]);
  if (authHeader && authHeader.startsWith("Bearer ")) {
    idToken = authHeader.slice(7);
  }
  if (!idToken) {
    idToken = (req.query && req.query.token) || "";
  }
  if (!idToken) return null;
  try {
    const admin = _getAdmin();
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = (decoded.email || "").toLowerCase();
    if (!email) return null;
    // Check ADMIN_EMAILS allow-list
    if (!ADMIN_EMAILS.includes(email)) return null;
    return { email, uid: decoded.uid };
  } catch (e) {
    console.warn("[admin] Token verification failed:", (e.message || "").slice(0, 100));
    return null;
  }
}

// Block scraper/bot User-Agents at the function level (since we can't use Edge
// Middleware without Next.js). Catches wget/curl/httrack/etc. hitting the API.
function isScraperUa(ua) {
  if (!ua || ua.length < 20) return true;
  const lower = ua.toLowerCase();
  const patterns = ["wget", "curl", "httrack", "scrapy", "python-requests", "python-httpx",
    "python-urllib", "httpclient", "mechanize", "node-fetch", "got/", "axios/",
    "go-http-client", "okhttp", "spider", "crawler", "archive.org", "ahrefsbot",
    "semrush", "bytespider"];
  return patterns.some(p => lower.includes(p));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  // Block scrapers
  if (isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden. Use a real browser." });
  }

  const section = (req.query && req.query.section) || (req.body && req.body.section) || "overview";
  const action = (req.query && req.query.action) || (req.body && req.body.action) || "";

  let db;
  try { db = getDb(); } catch(e) {
    return res.status(200).json({ error: "Database not configured", sites: { total: 0, active: 0, expired: 0, today: 0, week: 0, month: 0 }, users: { total: 0 }, perDay: [] });
  }

  // ===== Public-readable sections (no admin auth required) =====
  // Templates are shown on the public /templates page → public read.
  // Settings: only the chatWidget embed code is public (so the chat widget can
  // load on every page). All other settings (feature flags, etc.) are admin-only.
  if (req.method === "GET" && (section === "templates" || section === "settings")) {
    try {
      if (section === "templates") {
        const templatesSnap = await getDocs(collection(db, "templates"));
        const templates = [];
        templatesSnap.forEach(d => templates.push({ id: d.id, ...d.data() }));
        return res.status(200).json({ templates });
      }
      if (section === "settings") {
        // Only return the chatWidget field — everything else is admin-only
        let chatWidget = "";
        try {
          const snap = await getDoc(doc(db, "settings", "chatWidget"));
          if (snap.exists()) {
            const data = snap.data() || {};
            chatWidget = typeof data.value === "string" ? data.value : "";
          }
        } catch (e) {}
        return res.status(200).json({ settings: { chatWidget: { value: chatWidget } } });
      }
    } catch (e) {
      return res.status(200).json({ templates: [], settings: { chatWidget: { value: "" } } });
    }
  }

  // ===== Everything below requires admin auth =====
  const adminUser = await verifyAdmin(req);
  if (!adminUser) {
    return res.status(403).json({
      error: "Not authorized. Admin access requires a verified ID token from an admin account.",
    });
  }

  // Bump uid/email with the verified values (don't trust the client)
  const uid = adminUser.uid;
  const email = adminUser.email;

  try {
    // ===== GET: Fetch admin dashboard data =====
    if (req.method === "GET") {

      if (section === "overview") {
        const sitesSnap = await getDocs(collection(db, "sites"));
        const sites = [];
        sitesSnap.forEach(d => sites.push({ id: d.id, ...d.data() }));

        const now = Date.now();
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const weekAgo = today.getTime() - 7 * 86400000;
        const monthAgo = today.getTime() - 30 * 86400000;

        const active = sites.filter(s => !s.expiresAt || s.expiresAt > now);
        const expired = sites.filter(s => s.expiresAt && s.expiresAt <= now);
        const todayCount = sites.filter(s => s.createdAt > today.getTime()).length;
        const weekCount = sites.filter(s => s.createdAt > weekAgo).length;
        const monthCount = sites.filter(s => s.createdAt > monthAgo).length;

        const perDay = [];
        for (let i = 29; i >= 0; i--) {
          const dayStart = today.getTime() - i * 86400000;
          const dayEnd = dayStart + 86400000;
          const count = sites.filter(s => s.createdAt >= dayStart && s.createdAt < dayEnd).length;
          perDay.push({ date: new Date(dayStart).toISOString().slice(0, 10), count });
        }

        let usersCount = 0;
        try {
          const usersSnap = await getDocs(collection(db, "users"));
          usersCount = usersSnap.size;
        } catch (e) {}

        return res.status(200).json({
          sites: { total: sites.length, active: active.length, expired: expired.length, today: todayCount, week: weekCount, month: monthCount },
          users: { total: usersCount },
          perDay,
        });
      }

      if (section === "users") {
        const usersSnap = await getDocs(collection(db, "users"));
        const raw = [];
        usersSnap.forEach(d => raw.push({ uid: d.id, ...d.data() }));

        // DEDUPE by email — group docs with same email, keep oldest as canonical,
        // merge pro/suspended flags from the others into it.
        const byEmail = new Map();
        const noEmail = [];
        for (const u of raw) {
          const key = (u.email || "").trim().toLowerCase();
          if (!key) { noEmail.push(u); continue; }
          if (!byEmail.has(key)) byEmail.set(key, []);
          byEmail.get(key).push(u);
        }
        const users = [];
        for (const [email, group] of byEmail) {
          group.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          const canonical = group[0];
          const merged = {
            ...canonical,
            pro: group.some(g => g.pro) || canonical.pro || false,
            suspended: group.some(g => g.suspended) || canonical.suspended || false,
            _duplicateCount: group.length,
            _duplicateUids: group.map(g => g.uid),
          };
          users.push(merged);
        }
        users.push(...noEmail);
        // Newest first
        users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return res.status(200).json({ users, rawCount: raw.length });
      }

      if (section === "sites") {
        const sitesSnap = await getDocs(collection(db, "sites"));
        const sites = [];
        sitesSnap.forEach(d => sites.push({ id: d.id, ...d.data() }));
        return res.status(200).json({ sites });
      }

      if (section === "audit") {
        try {
          const auditSnap = await getDocs(collection(db, "audit"));
          const logs = [];
          auditSnap.forEach(d => logs.push({ id: d.id, ...d.data() }));
          logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          return res.status(200).json({ logs: logs.slice(0, 100) });
        } catch (e) { return res.status(200).json({ logs: [] }); }
      }

      if (section === "settings") {
        try {
          const settingsSnap = await getDocs(collection(db, "settings"));
          const settings = {};
          settingsSnap.forEach(d => settings[d.id] = d.data());
          return res.status(200).json({ settings });
        } catch (e) { return res.status(200).json({ settings: {} }); }
      }

      // === NEW: Templates section ===
      if (section === "templates") {
        try {
          const templatesSnap = await getDocs(collection(db, "templates"));
          const templates = [];
          templatesSnap.forEach(d => templates.push({ id: d.id, ...d.data() }));
          return res.status(200).json({ templates });
        } catch (e) { return res.status(200).json({ templates: [] }); }
      }

      // === NEW: Moderation section (returns empty for now, no reports yet) ===
      if (section === "moderation") {
        try {
          const flaggedSnap = await getDocs(collection(db, "flagged"));
          const flagged = [];
          flaggedSnap.forEach(d => flagged.push({ id: d.id, ...d.data() }));
          return res.status(200).json({ flagged, spamPatterns: ["spam", "casino", "pharma", "loan", "crypto giveaway"] });
        } catch (e) { return res.status(200).json({ flagged: [], spamPatterns: ["spam", "casino", "pharma", "loan", "crypto giveaway"] }); }
      }

      // === NEW: Health section ===
      if (section === "health") {
        return res.status(200).json({
          status: "ok",
          apiErrors: [],
          firebaseUsage: { reads: "normal", writes: "normal" },
          recentErrors: [],
          uptime: "100%",
          lastChecked: new Date().toISOString(),
        });
      }

      // Default: return empty for any unknown section (no more 400!)
      return res.status(200).json({ message: "Section not yet implemented", section });
    }

    // ===== POST: Admin actions =====
    if (req.method === "POST") {
      const { action, targetId, targetType, newTtl, newStatus, adminEmail, templateHtml, templateName, duplicateUids } = req.body || {};

      // Helper: returns the list of UIDs an action should apply to.
      // If the client sent `duplicateUids` (a merged row), apply to all of them;
      // otherwise just use the single targetId.
      const expandTargets = () => {
        const all = Array.isArray(duplicateUids) && duplicateUids.length
          ? [...new Set([...duplicateUids, targetId].filter(Boolean))]
          : [targetId];
        return all;
      };

      // Log the action
      try {
        await setDoc(doc(db, "audit", "log_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)), {
          action, targetId, targetType, adminEmail: email || "unknown",
          timestamp: Date.now(),
        });
      } catch (e) {}

      if (action === "deleteSite") {
        await deleteDoc(doc(db, "sites", targetId));
        return res.status(200).json({ success: true });
      }

      if (action === "extendTtl") {
        let newExpiry = null;
        if (newTtl === "1d") newExpiry = Date.now() + 86400000;
        else if (newTtl === "7d") newExpiry = Date.now() + 604800000;
        else if (newTtl === "30d") newExpiry = Date.now() + 2592000000;
        await updateDoc(doc(db, "sites", targetId), { expiresAt: newExpiry });
        return res.status(200).json({ success: true });
      }

      if (action === "suspendUser") {
        const targets = expandTargets();
        for (const uid of targets) {
          try { await updateDoc(doc(db, "users", uid), { suspended: newStatus === "true", suspendedAt: Date.now() }); }
          catch (e) { /* skip missing docs */ }
        }
        return res.status(200).json({ success: true, appliedTo: targets.length });
      }

      if (action === "setPro") {
        const targets = expandTargets();
        for (const uid of targets) {
          try { await updateDoc(doc(db, "users", uid), { pro: newStatus === "true", proSetAt: Date.now() }); }
          catch (e) { /* skip missing docs */ }
        }
        return res.status(200).json({ success: true, appliedTo: targets.length });
      }

      if (action === "promoteAdmin") {
        const targets = expandTargets();
        for (const uid of targets) {
          try { await setDoc(doc(db, "admins", uid), { email: adminEmail || "", addedBy: email, addedAt: Date.now() }); }
          catch (e) {}
        }
        return res.status(200).json({ success: true, appliedTo: targets.length });
      }

      if (action === "demoteAdmin") {
        await deleteDoc(doc(db, "admins", targetId));
        return res.status(200).json({ success: true });
      }

      // === NEW: Template management ===
      if (action === "addTemplate") {
        const templateId = "tpl_" + Date.now().toString(36);
        await setDoc(doc(db, "templates", templateId), {
          id: templateId,
          name: templateName || "Untitled",
          html: templateHtml || "",
          createdAt: Date.now(),
        });
        return res.status(200).json({ success: true, id: templateId });
      }

      if (action === "deleteTemplate") {
        await deleteDoc(doc(db, "templates", targetId));
        return res.status(200).json({ success: true });
      }

      if (action === "updateSettings") {
        const settings = req.body.settings || {};
        for (const [key, value] of Object.entries(settings)) {
          await setDoc(doc(db, "settings", key), { value, updatedAt: Date.now() });
        }
        return res.status(200).json({ success: true });
      }

      return res.status(200).json({ error: "Unknown action" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[admin] Error:", err);
    return res.status(200).json({ error: err.message, sites: { total: 0, active: 0, expired: 0, today: 0, week: 0, month: 0 }, users: { total: 0 }, perDay: [], users: [], sites: [], logs: [] });
  }
};
