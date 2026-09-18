// /api/clone.js — fetches a URL's HTML and returns it.
// Fixes: SSRF protection, relative links via <base> tag, timeout, size limit, SPA warning.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "URL required" });

  // --- 1. Validate URL scheme ---
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    return res.status(400).json({ error: "Invalid URL. Must start with http:// or https://" });
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return res.status(400).json({ error: "Only http:// and https:// URLs are allowed." });
  }

  // --- 2. SSRF protection — block internal/private IPs ---
  const hostname = parsedUrl.hostname.toLowerCase();
  const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "metadata.google.internal"];
  for (const h of blockedHosts) {
    if (hostname === h || hostname.endsWith("." + h)) {
      return res.status(403).json({ error: "This URL points to an internal/private address and cannot be cloned." });
    }
  }

  // Check IP ranges via regex (covers common private ranges + cloud metadata)
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [_, a, b] = ipMatch.map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 127)) {
      return res.status(403).json({ error: "This URL points to a private/internal IP range and cannot be cloned." });
    }
  }

  // --- 3. Fetch with timeout (8s — leaves 2s buffer under Vercel's 10s function limit) ---
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let fetchRes;
  let finalUrl = url;
  try {
    fetchRes = await fetch(url, {
      headers: { "User-Agent": "KayhostHTML/1.0" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // Re-validate final URL after redirects
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

  // --- 4. Size limit (5MB) ---
  const contentLength = parseInt(fetchRes.headers.get("content-length") || "0", 10);
  if (contentLength > 5 * 1024 * 1024) {
    return res.status(413).json({ error: "That page is too large (>5MB). Try a smaller page." });
  }

  let html = await fetchRes.text();
  if (html.length > 5 * 1024 * 1024) {
    return res.status(413).json({ error: "That page is too large (>5MB). Try a smaller page." });
  }

  // --- 5. Fix relative links — inject <base> tag ---
  const baseTag = `<base href="${escapeAttr(finalUrl)}">`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
  } else {
    html = `<!DOCTYPE html><html><head>${baseTag}</head><body>${html}</body></html>`;
  }

  // --- 6. SPA shell detection ---
  let warning = null;
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    const bodyText = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "").trim();
    const hasRootDiv = /<div[^>]+id=["']?(root|app)["']?/i.test(html);
    if (bodyText.length < 100 || (hasRootDiv && bodyText.length < 200)) {
      warning = "This page may require JavaScript to render — the cloned copy might look mostly blank. This is common with React, Vue, and other SPA frameworks.";
    }
  }

  return res.status(200).json({ html, warning });
};

function escapeAttr(s) {
  return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
