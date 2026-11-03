// PATCH FILE — add this code to api/main.js
//
// WHERE TO ADD:
//   1. Find the line that says:  switch (route) {
//   2. Add the new case statements below to that switch block
//   3. Paste the handler functions at the bottom of the file (before module.exports if any)
//
// WHAT THIS DOES:
//   - Adds "custom-domain-serve" route — serves a site based on the Host header
//     (called by middleware.js when a custom domain request comes in)
//   - Adds "form-count" route — returns the number of form submissions for a site
//     (used by the dashboard to show a badge next to each site)

// =====================================================================
// ADD THESE CASES TO THE switch (route) BLOCK IN api/main.js
// =====================================================================

/*

    case "custom-domain-serve": return handleCustomDomainServe(req, res);
    case "form-count": return handleFormCount(req, res);

*/

// =====================================================================
// ADD THESE HANDLER FUNCTIONS AT THE BOTTOM OF api/main.js
// =====================================================================

/*

// ----- Custom domain serving (called by middleware.js for non-main hosts) -----
async function handleCustomDomainServe(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const host = (req.query.host || req.headers.host || "").toLowerCase();
  const originalPath = req.query.originalPath || "/";

  if (!host) {
    return res.status(400).send("Missing host");
  }

  try {
    const { getDb } = require("../lib/firebase");
    const { collection, query, where, getDocs, doc, getDoc } = require("firebase/firestore");
    const multipage = require("../lib/multipage");

    const db = getDb();

    // 1. Find the custom domain record
    const q = query(collection(db, "customDomains"), where("domain", "==", host), where("status", "==", "verified"));
    const snap = await getDocs(q);
    if (snap.empty) {
      return res.status(404).send(renderCfError("Domain not verified", "This domain is linked to kayhost but not yet verified. If you're the owner, complete the DNS verification in your dashboard."));
    }
    const cfData = snap.docs[0].data();
    const siteId = cfData.siteId;

    // 2. Look up the site
    const siteSnap = await getDoc(doc(db, "sites", siteId));
    if (!siteSnap.exists()) {
      return res.status(404).send(renderCfError("Site not found", "The site linked to this domain no longer exists."));
    }
    const siteData = siteSnap.data();

    // 3. Check expiry
    if (siteData.expiresAt && Date.now() > siteData.expiresAt) {
      return res.status(410).send(renderCfError("Expired", "This site has expired."));
    }

    // 4. If single-page site (has html field), serve directly
    if (siteData.html) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).send(siteData.html);
    }

    // 5. If multi-page project (has filesJson), resolve the path
    if (siteData.filesJson) {
      const files = JSON.parse(siteData.filesJson);
      const pathMap = siteData.pathMapJson ? JSON.parse(siteData.pathMapJson) : multipage.buildPathMap(files);
      const filePath = multipage.resolvePath(originalPath, pathMap);
      if (!filePath) {
        return res.status(404).send(renderCfError("Not found", `The path ${originalPath} doesn't exist on this site.`));
      }
      const content = files[filePath];
      if (!content) {
        return res.status(404).send(renderCfError("Not found", `The file ${filePath} is missing.`));
      }
      res.setHeader("Content-Type", multipage.getMimeType(filePath));
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).send(content);
    }

    return res.status(404).send(renderCfError("No content", "This site has no content to serve."));
  } catch (err) {
    console.error("[custom-domain-serve] Error:", err);
    return res.status(500).send(renderCfError("Server error", err.message));
  }
}

function renderCfError(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Kayhost</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#08080C;color:#F5F5FA;display:grid;place-items:center;min-height:100vh;padding:24px}.card{max-width:420px;text-align:center;padding:40px 32px;background:rgba(255,255,255,0.03);border:1px solid rgba(192,132,252,0.25);border-radius:20px}.ico{width:48px;height:48px;border-radius:12px;background:rgba(192,132,252,0.12);display:grid;place-items:center;margin:0 auto 16px;color:#C084FC;font-size:24px}h1{font-size:22px;margin-bottom:8px}p{color:#8B8B9A;font-size:14px;line-height:1.5}</style></head><body><div class="card"><div class="ico">⚠</div><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

// ----- Form submission count (for dashboard badge) -----
async function handleFormCount(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  const { verifyRequestToken } = require("../lib/admin-firebase");
  let decoded;
  try {
    decoded = await verifyRequestToken(req);
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }

  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: "Missing siteId" });

  try {
    const { getDb } = require("../lib/firebase");
    const { collection, query, where, getDocs } = require("firebase/firestore");
    const db = getDb();
    const q = query(collection(db, "formSubmissions"), where("siteId", "==", siteId));
    const snap = await getDocs(q);
    return res.status(200).json({ siteId, count: snap.size });
  } catch (err) {
    console.error("[form-count] Error:", err);
    return res.status(500).json({ error: "Failed to count submissions" });
  }
}

*/
