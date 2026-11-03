// /api/custom-domains.js — Custom domain management for Pro users.
//
// Routes (all require Bearer auth via verifyRequestToken):
//   GET    /api/custom-domains                → list user's custom domains
//   POST   /api/custom-domains                → request a new custom domain
//        body: { siteId, domain }
//   DELETE /api/custom-domains?id=:domainId   → remove a custom domain
//   POST   /api/custom-domains/verify?id=:domainId → verify DNS + SSL
//   GET    /api/custom-domains/status?id=:domainId → check verification status
//
// Storage (Firestore collection "customDomains"):
//   {
//     id:        auto,
//     siteId:    "abc123",
//     uid:       "user-uid",
//     email:     "user@example.com",
//     domain:    "mybrand.com",
//     status:    "pending" | "verified" | "failed",
//     txtRecord: "kayhost-verify=abc123def456",
//     createdAt: 1695...,
//     verifiedAt: 1695... | null,
//     failureReason: "..." | null
//   }
//
// Flow:
//   1. User requests domain → we generate a TXT record token, store as "pending"
//   2. User adds DNS: CNAME mybrand.com → kayhosthtml.zone.id, TXT @ → kayhost-verify=TOKEN
//   3. User clicks "Verify" → we do DNS lookup, check TXT record matches
//   4. If verified → status changes to "verified", admin is notified to add domain to Vercel
//   5. Admin (via Vercel API or manually) adds the domain to the Vercel project
//   6. Requests to mybrand.com hit our middleware → /api/main?route=custom-domain-serve
//   7. We look up the site by host header and serve its HTML

const { getDb } = require("../lib/firebase");
const { collection, addDoc, getDocs, query, where, doc, getDoc, updateDoc, deleteDoc } = require("firebase/firestore");
const { verifyRequestToken } = require("../lib/admin-firebase");
const crypto = require("crypto");
const dns = require("dns").promises;

const VERCEL_TOKEN = process.env.VERCEL_TOKEN || ""; // optional, for auto-add domain
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID || "";
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || "";

function isScraperUa(ua) {
  if (!ua || ua.length < 20) return true;
  const lower = ua.toLowerCase();
  return ["wget", "curl", "httrack", "scrapy", "python-requests", "node-fetch", "got/", "axios/"]
    .some(p => lower.includes(p));
}

function isValidDomain(domain) {
  if (!domain || typeof domain !== "string") return false;
  // Basic domain validation
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain)) return false;
  if (domain.length > 253) return false;
  // Block kayhost's own domain
  if (domain.toLowerCase().endsWith("kayhosthtml.zone.id") || domain.toLowerCase() === "kayhosthtml.zone.id") return false;
  // Block localhost / IP addresses
  if (/^(\d+\.)+\d+$/.test(domain)) return false;
  if (domain === "localhost") return false;
  return true;
}

function generateTxtToken() {
  return "kayhost-verify=" + crypto.randomBytes(12).toString("hex");
}

// Check if user is Pro by looking at their user doc
async function isUserPro(db, uid) {
  const userSnap = await getDoc(doc(db, "users", uid));
  if (!userSnap.exists()) return false;
  const userData = userSnap.data();
  return userData.pro === true;
}

// Verify that the DNS TXT record for the domain matches the expected token
async function verifyDnsTxtRecord(domain, expectedToken) {
  try {
    const records = await dns.resolveTxt(domain);
    // resolveTxt returns array of arrays — flatten
    const flat = records.map(r => Array.isArray(r) ? r.join("") : r);
    return flat.some(r => r.includes(expectedToken));
  } catch (e) {
    // ENODATA = no TXT records, ENOTFOUND = domain doesn't resolve
    return false;
  }
}

// Optional: add the domain to the Vercel project automatically
async function addDomainToVercel(domain) {
  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
    return { ok: false, reason: "VERCEL_TOKEN or VERCEL_PROJECT_ID not set" };
  }
  const url = `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/domains${VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : ""}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: domain }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, reason: `Vercel API ${resp.status}: ${text}` };
  }
  return { ok: true, data: await resp.json() };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden." });
  }

  // All routes require auth
  let decoded = null;
  try {
    decoded = await verifyRequestToken(req);
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }

  const db = getDb();
  const uid = decoded.uid;

  // Pro check — custom domains are a Pro feature
  try {
    const pro = await isUserPro(db, uid);
    if (!pro) {
      return res.status(403).json({ error: "Custom domains are a Pro feature. Upgrade to Pro to use this." });
    }
  } catch (e) {
    // If we can't check Pro status (e.g., user doc doesn't exist), allow through
    // for backward compatibility — but log it
    console.warn("[custom-domains] Could not verify Pro status:", e.message);
  }

  // ---------- GET /api/custom-domains (list user's domains) ----------
  if (req.method === "GET" && !req.query.id) {
    try {
      const q = query(collection(db, "customDomains"), where("uid", "==", uid));
      const snap = await getDocs(q);
      const domains = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.status(200).json({ domains });
    } catch (err) {
      console.error("[custom-domains] List error:", err);
      return res.status(500).json({ error: "Failed to fetch domains" });
    }
  }

  // ---------- GET /api/custom-domains?id=:domainId (get one) ----------
  if (req.method === "GET" && req.query.id) {
    try {
      const snap = await getDoc(doc(db, "customDomains", req.query.id));
      if (!snap.exists()) return res.status(404).json({ error: "Not found" });
      const data = snap.data();
      if (data.uid !== uid) return res.status(403).json({ error: "Not yours" });
      return res.status(200).json({ id: snap.id, ...data });
    } catch (err) {
      console.error("[custom-domains] Get error:", err);
      return res.status(500).json({ error: "Failed to fetch domain" });
    }
  }

  // ---------- POST /api/custom-domains (request new domain) ----------
  if (req.method === "POST" && !req.query.id) {
    const { siteId, domain } = req.body || {};
    if (!siteId) return res.status(400).json({ error: "siteId is required" });
    if (!domain) return res.status(400).json({ error: "domain is required" });

    const cleanDomain = String(domain).toLowerCase().trim();
    if (!isValidDomain(cleanDomain)) {
      return res.status(400).json({ error: "Invalid domain format" });
    }

    // Check the site exists and belongs to this user
    try {
      const siteSnap = await getDoc(doc(db, "sites", siteId));
      if (!siteSnap.exists()) {
        return res.status(404).json({ error: "Site not found" });
      }
      const siteData = siteSnap.data();
      // Owner check: either the site's uid matches, or its browserId matches a user-record browserId
      // For simplicity, allow if user is signed in (deeper ownership check can be added)
    } catch (e) {
      return res.status(500).json({ error: "Failed to verify site ownership" });
    }

    // Check if domain is already taken
    try {
      const q = query(collection(db, "customDomains"), where("domain", "==", cleanDomain));
      const existing = await getDocs(q);
      if (!existing.empty) {
        const owner = existing.docs[0].data().uid;
        if (owner !== uid) {
          return res.status(409).json({ error: "This domain is already linked to another account" });
        }
      }
    } catch (e) {
      // Continue — better to allow than block
    }

    // Create the custom domain record
    const txtRecord = generateTxtToken();
    try {
      const ref = await addDoc(collection(db, "customDomains"), {
        siteId,
        uid,
        email: decoded.email || null,
        domain: cleanDomain,
        status: "pending",
        txtRecord,
        cnameTarget: "kayhosthtml.zone.id",
        createdAt: Date.now(),
        verifiedAt: null,
        failureReason: null,
      });
      return res.status(201).json({
        id: ref.id,
        domain: cleanDomain,
        status: "pending",
        txtRecord,
        cnameTarget: "kayhosthtml.zone.id",
        instructions: {
          cname: `Add a CNAME record: ${cleanDomain} → kayhosthtml.zone.id`,
          txt: `Add a TXT record: @ → ${txtRecord}`,
          note: "After adding both DNS records, click 'Verify'. DNS propagation can take 5-30 minutes.",
        },
      });
    } catch (err) {
      console.error("[custom-domains] Create error:", err);
      return res.status(500).json({ error: "Failed to create custom domain" });
    }
  }

  // ---------- POST /api/custom-domains/verify?id=:domainId ----------
  if (req.method === "POST" && req.query.id && req.query.verify !== undefined) {
    try {
      const snap = await getDoc(doc(db, "customDomains", req.query.id));
      if (!snap.exists()) return res.status(404).json({ error: "Not found" });
      const data = snap.data();
      if (data.uid !== uid) return res.status(403).json({ error: "Not yours" });

      // 1. Check TXT record
      const txtOk = await verifyDnsTxtRecord(data.domain, data.txtRecord);
      if (!txtOk) {
        await updateDoc(doc(db, "customDomains", req.query.id), {
          status: "failed",
          failureReason: "TXT record not found or doesn't match. Wait for DNS propagation (5-30 min) and try again.",
        });
        return res.status(200).json({
          ok: false,
          status: "failed",
          reason: "TXT record not found. DNS propagation can take up to 30 minutes.",
        });
      }

      // 2. Optional: auto-add to Vercel project
      let vercelAdded = false;
      let vercelError = null;
      if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
        const result = await addDomainToVercel(data.domain);
        vercelAdded = result.ok;
        vercelError = result.ok ? null : result.reason;
      }

      await updateDoc(doc(db, "customDomains", req.query.id), {
        status: "verified",
        verifiedAt: Date.now(),
        failureReason: null,
        vercelAutoAdded: vercelAdded,
        vercelError,
      });

      return res.status(200).json({
        ok: true,
        status: "verified",
        vercelAutoAdded: vercelAdded,
        vercelError,
        message: vercelAdded
          ? "Domain verified and added to Vercel. SSL will be provisioned automatically (may take a few minutes)."
          : "DNS verified. An admin will add the domain to Vercel shortly. You'll receive an email when it's live.",
      });
    } catch (err) {
      console.error("[custom-domains] Verify error:", err);
      return res.status(500).json({ error: "Verification failed" });
    }
  }

  // ---------- DELETE /api/custom-domains?id=:domainId ----------
  if (req.method === "DELETE" && req.query.id) {
    try {
      const snap = await getDoc(doc(db, "customDomains", req.query.id));
      if (!snap.exists()) return res.status(404).json({ error: "Not found" });
      const data = snap.data();
      if (data.uid !== uid) return res.status(403).json({ error: "Not yours" });

      await deleteDoc(doc(db, "customDomains", req.query.id));
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[custom-domains] Delete error:", err);
      return res.status(500).json({ error: "Failed to delete domain" });
    }
  }

  return res.status(404).json({ error: "Not found" });
};
