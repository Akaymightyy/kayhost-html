// /api/admin.js — Server-side admin data endpoint
// Checks admin status using the Firebase client SDK.
// Admin emails are hardcoded below + checked against Firestore admins collection.

const { getDb } = require("./_firebase");
const { collection, getDocs, doc, getDoc, query, where, orderBy, limit } = require("firebase/firestore");

// Admin emails — replace with your real admin email(s)
const ADMIN_EMAILS = ["kayhost@admin.com", "awwalabdul891@gmail.com"];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Get uid/email from query params (GET) or body (POST) — check BOTH
  const uid = (req.query && req.query.uid) || (req.body && req.body.uid) || "";
  const email = (req.query && req.query.email) || (req.body && req.body.email) || "";
  const action = (req.query && req.query.action) || (req.body && req.body.action) || "";
  const section = (req.query && req.query.section) || "overview";

  // Check admin status
  const isAdmin = email && ADMIN_EMAILS.includes(email.toLowerCase());
  if (!isAdmin) {
    // Also check Firestore admins collection
    try {
      const db = getDb();
      const adminDoc = await getDoc(doc(db, "admins", uid || "x"));
      if (!adminDoc.exists()) {
        return res.status(403).json({ error: "Not authorized" });
      }
    } catch (e) {
      return res.status(403).json({ error: "Not authorized" });
    }
  }

  const db = getDb();

  try {
    // ===== GET: Fetch admin dashboard data =====
    if (req.method === "GET") {
      // section is already set above from query params

      if (section === "overview") {
        // Fetch all sites and users for stats
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

        // Sites per day (last 30 days) for chart
        const perDay = [];
        for (let i = 29; i >= 0; i--) {
          const dayStart = today.getTime() - i * 86400000;
          const dayEnd = dayStart + 86400000;
          const count = sites.filter(s => s.createdAt >= dayStart && s.createdAt < dayEnd).length;
          perDay.push({ date: new Date(dayStart).toISOString().slice(0, 10), count });
        }

        // Users count
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
        const users = [];
        usersSnap.forEach(d => users.push({ uid: d.id, ...d.data() }));
        return res.status(200).json({ users });
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

      return res.status(400).json({ error: "Unknown section" });
    }

    // ===== POST: Admin actions =====
    if (req.method === "POST") {
      const { action, targetId, targetType, newTtl, newStatus, adminEmail } = req.body || {};

      // Log the action
      try {
        const { setDoc } = require("firebase/firestore");
        await setDoc(doc(db, "audit", "log_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)), {
          action, targetId, targetType, adminEmail: email || "unknown",
          timestamp: Date.now(),
        });
      } catch (e) {}

      if (action === "deleteSite") {
        const { deleteDoc } = require("firebase/firestore");
        await deleteDoc(doc(db, "sites", targetId));
        return res.status(200).json({ success: true });
      }

      if (action === "extendTtl") {
        const { updateDoc } = require("firebase/firestore");
        let newExpiry = null;
        if (newTtl === "1d") newExpiry = Date.now() + 86400000;
        else if (newTtl === "7d") newExpiry = Date.now() + 604800000;
        else if (newTtl === "30d") newExpiry = Date.now() + 2592000000;
        await updateDoc(doc(db, "sites", targetId), { expiresAt: newExpiry });
        return res.status(200).json({ success: true });
      }

      if (action === "suspendUser" || action === "promoteAdmin" || action === "demoteAdmin") {
        const { setDoc, deleteDoc } = require("firebase/firestore");
        if (action === "promoteAdmin") {
          await setDoc(doc(db, "admins", targetId), { email: adminEmail || "", addedBy: email, addedAt: Date.now() });
        } else if (action === "demoteAdmin") {
          await deleteDoc(doc(db, "admins", targetId));
        } else if (action === "suspendUser") {
          const { updateDoc } = require("firebase/firestore");
          await updateDoc(doc(db, "users", targetId), { suspended: newStatus === "true" });
        }
        return res.status(200).json({ success: true });
      }

      if (action === "updateSettings") {
        const { setDoc } = require("firebase/firestore");
        const settings = req.body.settings || {};
        for (const [key, value] of Object.entries(settings)) {
          await setDoc(doc(db, "settings", key), { value, updatedAt: Date.now() });
        }
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[admin] Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
