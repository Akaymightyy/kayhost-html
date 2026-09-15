// /api/site/[id].js — serves raw HTML from Firestore with expiry check.
const { getDb } = require("../_firebase");
const { doc, getDoc } = require("firebase/firestore");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    // Extract site ID from URL: /site/{id} → req.query.id
    const id = req.query.id || (req.url.split("/site/")[1] || "").split("/")[0] || "";

    if (!id) {
      return res.status(404).send(renderError("No site ID", "This link is missing a site ID."));
    }

    const db = getDb();
    const snap = await getDoc(doc(db, "sites", id));

    if (!snap.exists()) {
      return res.status(404).send(renderError("Not found", "This link doesn't exist or has been deleted."));
    }

    const data = snap.data();

    // Check expiry
    if (data.expiresAt && Date.now() > data.expiresAt) {
      return res.status(410).send(renderExpired(data.title || "Untitled"));
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(data.html);
  } catch (err) {
    console.error("[site] Error:", err);
    return res.status(500).send(renderError("Server error", err.message));
  }
};

function renderError(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Kayhost</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#08080C;color:#F5F5FA;display:grid;place-items:center;min-height:100vh;padding:24px}.card{max-width:420px;text-align:center;padding:40px 32px;background:rgba(255,255,255,0.03);border:1px solid rgba(192,132,252,0.25);border-radius:20px}.ico{width:48px;height:48px;border-radius:12px;background:rgba(192,132,252,0.12);display:grid;place-items:center;margin:0 auto 16px;color:#C084FC;font-size:24px}h1{font-size:22px;margin-bottom:8px;font-family:system-ui}p{color:#8B8B9A;font-size:14px;line-height:1.5}a{display:inline-block;margin-top:20px;color:#C084FC;text-decoration:none;font-weight:600}</style></head><body><div class="card"><div class="ico">⚠</div><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/">Go to Kayhost</a></div></body></html>`;
}

function renderExpired(title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Expired — ${esc(title)}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#08080C;color:#F5F5FA;display:grid;place-items:center;min-height:100vh;padding:24px}.card{max-width:420px;text-align:center;padding:40px 32px;background:rgba(255,255,255,0.03);border:1px solid rgba(245,158,11,0.2);border-radius:20px}.ico{width:48px;height:48px;border-radius:12px;background:rgba(245,158,11,0.12);display:grid;place-items:center;margin:0 auto 16px;color:#f59e0b;font-size:24px}h1{font-size:22px;margin-bottom:8px;font-family:system-ui}p{color:#8B8B9A;font-size:14px;line-height:1.5}a{display:inline-block;margin-top:20px;color:#C084FC;text-decoration:none;font-weight:600}</style></head><body><div class="card"><div class="ico">⏰</div><h1>This link has expired</h1><p>"${esc(title)}" was set to expire and is no longer available.</p><a href="/">Create a new page on Kayhost</a></div></body></html>`;
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
