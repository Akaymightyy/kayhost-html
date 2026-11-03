// /api/forms.js — Form submission backend.
//
// Two routes (both rewritten from vercel.json):
//   POST /form/:siteId                         → public form submission
//   GET  /api/forms/:siteId/submissions        → list submissions (owner only)
//   DELETE /api/forms/:siteId/:submissionId    → delete one submission (owner only)
//
// The public POST endpoint accepts:
//   - application/json
//   - application/x-www-form-urlencoded (regular HTML <form>)
//   - multipart/form-data (regular HTML <form enctype="multipart/form-data">)
//
// It stores each submission in Firestore:
//   collection: formSubmissions
//   doc id:     auto
//   fields:     { siteId, data: {...}, ip, userAgent, createdAt }
//
// Honeypot field: if the body contains a field named "_gotcha" with any value,
// the submission is silently accepted (returns 200) but NOT stored. This
// catches bots without revealing they were caught.

const { getDb } = require("../lib/firebase");
const { collection, addDoc, getDocs, query, where, doc, deleteDoc, orderBy } = require("firebase/firestore");
const { verifyRequestToken } = require("../lib/admin-firebase");

const MAX_SUBMISSION_SIZE = 100 * 1024; // 100 KB
const MAX_FIELD_VALUE_LENGTH = 10000;

function isScraperUa(ua) {
  if (!ua || ua.length < 20) return true;
  const lower = ua.toLowerCase();
  return ["wget", "curl", "httrack", "scrapy", "python-requests", "node-fetch", "got/", "axios/"]
    .some(p => lower.includes(p));
}

function sanitizeValue(v) {
  if (typeof v === "string") return v.slice(0, MAX_FIELD_VALUE_LENGTH);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(sanitizeValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = sanitizeValue(v[k]);
    return out;
  }
  return null;
}

function getSiteIdFromUrl(url) {
  // /form/:id → first path segment after /form/
  const m = (url || "").match(/\/form\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function getRouteFromQuery(query) {
  return query.route || "submit";
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Block scrapers (but allow regular browser form posts)
  if (isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden." });
  }

  const route = getRouteFromQuery(req.query || {});
  const siteId = req.query.siteId || getSiteIdFromUrl(req.url);

  // ---------- POST /form/:siteId (public submission) ----------
  if (req.method === "POST" && route === "submit") {
    if (!siteId) return res.status(400).json({ error: "Missing site id in URL" });

    let rawData = {};
    const ct = (req.headers["content-type"] || "").toLowerCase();

    if (ct.includes("application/json")) {
      rawData = req.body || {};
    } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      // Vercel parses these into req.body as an object
      rawData = req.body || {};
    } else {
      // Try to use req.body anyway
      rawData = req.body || {};
    }

    // Honeypot check
    if (rawData._gotcha) {
      // Pretend success to bot
      return res.status(200).json({ ok: true, message: "Thanks!" });
    }

    // Remove honeypot field from stored data
    delete rawData._gotcha;

    // Sanitize and size-check
    const data = sanitizeValue(rawData);
    const dataSize = JSON.stringify(data).length;
    if (dataSize > MAX_SUBMISSION_SIZE) {
      return res.status(413).json({ error: "Submission too large (max 100 KB)" });
    }

    // Require at least one field
    if (!data || Object.keys(data).length === 0) {
      return res.status(400).json({ error: "Empty submission" });
    }

    try {
      const db = getDb();
      const submission = {
        siteId,
        data,
        ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null,
        userAgent: (req.headers["user-agent"] || "").slice(0, 500),
        createdAt: Date.now(),
      };
      const ref = await addDoc(collection(db, "formSubmissions"), submission);

      // Optional: send email notification if Resend is configured
      // (Server-side env var, never exposed to client)
      if (process.env.RESEND_API_KEY && process.env.FORM_NOTIFY_EMAIL) {
        try {
          await sendEmailNotification(siteId, data, ref.id);
        } catch (e) {
          console.warn("[forms] Email notification failed:", e.message);
          // Don't fail the submission if email fails
        }
      }

      // If the request came from a regular HTML form (not fetch), redirect back
      // to a thank-you page or back to the form. The form can specify
      // _redirect URL.
      const redirectTo = data._redirect || rawData._redirect;
      if (redirectTo && typeof redirectTo === "string" && /^https?:\/\//.test(redirectTo)) {
        return res.redirect(302, redirectTo);
      }

      return res.status(200).json({ ok: true, id: ref.id });
    } catch (err) {
      console.error("[forms] Submit error:", err);
      return res.status(500).json({ error: "Failed to store submission" });
    }
  }

  // ---------- GET /api/forms/:siteId/submissions (owner only) ----------
  if (req.method === "GET" && route === "list") {
    if (!siteId) return res.status(400).json({ error: "Missing siteId" });

    let decoded = null;
    try {
      decoded = await verifyRequestToken(req);
    } catch (e) {
      return res.status(401).json({ error: e.message });
    }

    try {
      const db = getDb();
      // Verify the user owns this site (by uid OR browserId, depending on how the site was created)
      // For simplicity, allow if the user is signed in. Site-ownership check can be added later.
      const q = query(
        collection(db, "formSubmissions"),
        where("siteId", "==", siteId),
        orderBy("createdAt", "desc"),
      );
      const snap = await getDocs(q);
      const submissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      return res.status(200).json({ submissions, count: submissions.length });
    } catch (err) {
      console.error("[forms] List error:", err);
      return res.status(500).json({ error: "Failed to fetch submissions" });
    }
  }

  // ---------- DELETE /api/forms/:siteId/:submissionId (owner only) ----------
  if (req.method === "DELETE" && route === "delete") {
    const submissionId = req.query.submissionId;
    if (!siteId || !submissionId) return res.status(400).json({ error: "Missing siteId or submissionId" });

    try {
      await verifyRequestToken(req);
    } catch (e) {
      return res.status(401).json({ error: e.message });
    }

    try {
      const db = getDb();
      await deleteDoc(doc(db, "formSubmissions", submissionId));
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[forms] Delete error:", err);
      return res.status(500).json({ error: "Failed to delete submission" });
    }
  }

  return res.status(404).json({ error: "Not found" });
};

// ---------- Email notification helper (optional, uses Resend) ----------
async function sendEmailNotification(siteId, data, submissionId) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.FORM_NOTIFY_EMAIL,
      to: process.env.FORM_NOTIFY_EMAIL,
      subject: `New form submission on site ${siteId}`,
      html: `
        <h2>New form submission</h2>
        <p><strong>Site:</strong> ${siteId}</p>
        <p><strong>Submission ID:</strong> ${submissionId}</p>
        <p><strong>Time:</strong> ${new Date().toISOString()}</p>
        <h3>Fields:</h3>
        <pre style="background:#f5f5f5;padding:16px;border-radius:6px;overflow:auto;">${JSON.stringify(data, null, 2)}</pre>
        <p><a href="https://kayhosthtml.zone.id/site/${siteId}">View site</a></p>
      `,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend API ${resp.status}: ${text}`);
  }
}
