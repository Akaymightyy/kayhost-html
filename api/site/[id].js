// /api/site/[id].js — fetches stored HTML from Firestore and returns it as text/html
// Checks expiry: if expired, shows a friendly "expired" page instead.
const { initFirebase } = require("../_firebase");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  
  try {
    // Extract the site ID from the URL path: /api/site/[id] → req.query.id
    // Vercel passes route params as query params for catch-all routes
    const id = req.query.id || (req.url.split("/site/")[1] || "").split("/")[0] || "";
    
    if (!id) {
      return res.status(404).send(renderError("No site ID provided", "This link is missing a site ID."));
    }

    const { db } = initFirebase();
    const doc = await db.collection("sites").doc(id).get();

    if (!doc.exists) {
      return res.status(404).send(renderError("Site not found", "This link doesn't exist or has been deleted."));
    }

    const data = doc.data();

    // Check expiry
    if (data.expiresAt && Date.now() > data.expiresAt) {
      return res.status(410).send(renderExpired(data.title || "Untitled"));
    }

    // Return the raw HTML with proper content type
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(data.html);
  } catch (err) {
    console.error("[site] Error:", err);
    return res.status(500).send(renderError("Server error", err.message));
  }
};

// --- HTML error/placeholder pages ---

function renderError(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} — Kayhost</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#070E16;color:#EDF2F8;display:grid;place-items:center;min-height:100vh;padding:24px}.card{max-width:420px;text-align:center;padding:40px 32px;background:rgba(255,255,255,0.03);border:1px solid rgba(34,197,94,0.2);border-radius:20px}.ico{width:48px;height:48px;border-radius:12px;background:rgba(34,197,94,0.12);display:grid;place-items:center;margin:0 auto 16px;color:#22C55E}h1{font-size:22px;margin-bottom:8px}p{color:#8F9AA4;font-size:14px;line-height:1.5}a{display:inline-block;margin-top:20px;color:#22C55E;text-decoration:none;font-weight:600}</style></head><body><div class="card"><div class="ico">⚠</div><h1>${escape(title)}</h1><p>${escape(message)}</p><a href="/">Go to Kayhost</a></div></body></html>`;
}

function renderExpired(title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Expired — ${escape(title)}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#070E16;color:#EDF2F8;display:grid;place-items:center;min-height:100vh;padding:24px}.card{max-width:420px;text-align:center;padding:40px 32px;background:rgba(255,255,255,0.03);border:1px solid rgba(245,158,11,0.2);border-radius:20px}.ico{width:48px;height:48px;border-radius:12px;background:rgba(245,158,11,0.12);display:grid;place-items:center;margin:0 auto 16px;color:#f59e0b;font-size:24px}h1{font-size:22px;margin-bottom:8px}p{color:#8F9AA4;font-size:14px;line-height:1.5}a{display:inline-block;margin-top:20px;color:#22C55E;text-decoration:none;font-weight:600}</style></head><body><div class="card"><div class="ico">⏰</div><h1>This link has expired</h1><p>"${escape(title)}" was set to expire and is no longer available.</p><a href="/">Create a new page on Kayhost</a></div></body></html>`;
}

function escape(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
