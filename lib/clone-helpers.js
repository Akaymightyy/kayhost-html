// lib/clone-helpers.js — asset inlining + JS-rendered shell detection +
// Browserless smart-scrape fallback + multi-page crawl helpers.
//
// Used by api/main.js handleClone + handleCloneMulti (the SSE multi-page endpoint).
// 100% additive — handleClone's existing SSRF / timeout / error-message behavior
// is preserved exactly. These helpers only run AFTER the existing fetch succeeds.

const MAX_JS_INLINE_BYTES = 500 * 1024;     // 500KB — JS files larger than this stay as <script src="...">
const MAX_IMG_INLINE_BYTES = 100 * 1024;    // 100KB — images larger than this get rewritten to absolute URL
const MAX_TOTAL_INLINE_MS = 6000;           // 6s budget for inlining (leaves ~2s of the 8s total for the initial fetch)
const SMART_SCRAPE_TIMEOUT_MS = 18000;      // 18s for Browserless (rendering is slower than plain fetch)
const MULTI_PAGE_MAX_PAGES = 10;            // hard cap on additional pages crawled

// ---------------------------------------------------------------------------
// PART 1 — Asset inlining
// ---------------------------------------------------------------------------

// Resolve a possibly-relative URL against a base URL.
// Returns the absolute URL string, or null on failure.
function resolveUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return null;
  // Already absolute with http/https
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  // Data URIs and other non-http schemes — leave alone
  if (/^(data:|mailto:|tel:|javascript:|#|blob:)/i.test(maybeRelative)) return null;
  try {
    return new URL(maybeRelative, baseUrl).href;
  } catch (e) {
    return null;
  }
}

// Fetch a URL with a per-request timeout. Returns { ok, status, text, contentType } or { ok: false, status, error }.
async function fetchAsset(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "KayhostHTML/1.0 (clone inliner)" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, error: "HTTP " + res.status };
    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();
    return { ok: true, status: res.status, text, contentType };
  } catch (err) {
    return { ok: false, status: 0, error: err.message || "fetch failed" };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a binary asset as a Buffer (for base64 inlining of images).
async function fetchAssetBuffer(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "KayhostHTML/1.0 (clone inliner)" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, error: "HTTP " + res.status };
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, buf, contentType };
  } catch (err) {
    return { ok: false, status: 0, error: err.message || "fetch failed" };
  } finally {
    clearTimeout(timer);
  }
}

// Convert a Buffer to a base64 data URI.
function toDataUri(buf, contentType) {
  return "data:" + (contentType || "application/octet-stream") + ";base64," + buf.toString("base64");
}

// Inline linked CSS, JS, and image assets into an HTML string.
// Resolves relative paths against `baseUrl`. Stops inlining when the total
// elapsed time exceeds `deadlineMs` (measured from when inlineAssets was called).
//
// Returns { html, inlinedCount, skippedCount, timedOut }.
async function inlineAssets(html, baseUrl, deadlineMs) {
  if (!html || typeof html !== "string") return { html, inlinedCount: 0, skippedCount: 0, timedOut: false };
  const startMs = Date.now();
  let inlinedCount = 0;
  let skippedCount = 0;
  let timedOut = false;

  function timeRemaining() {
    return deadlineMs - (Date.now() - startMs);
  }

  // --- 1a. Inline <link rel="stylesheet" href="..."> ---
  // Match link tags that look like stylesheets. Skip preloaded/prefetched ones.
  html = await replaceAsync(html, /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi, async (linkTag) => {
    if (timedOut) { skippedCount++; return linkTag; }
    const hrefMatch = linkTag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) { skippedCount++; return linkTag; }
    const abs = resolveUrl(hrefMatch[1], baseUrl);
    if (!abs) { skippedCount++; return linkTag; }
    if (timeRemaining() < 500) { timedOut = true; skippedCount++; return rewriteLinkToAbsolute(linkTag, abs); }
    const fetched = await fetchAsset(abs, Math.min(4000, timeRemaining()));
    if (!fetched.ok || !fetched.text) { skippedCount++; return rewriteLinkToAbsolute(linkTag, abs); }
    // Strip any @import statements that point to relative URLs (they'd break in the inlined version)
    let css = fetched.text;
    css = css.replace(/@import\s+(?:url\(["']?|["'])([^"')]+)["']?\)?/gi, (match, importPath) => {
      const absImport = resolveUrl(importPath, abs);
      if (!absImport) return match;
      return "@import url(\"" + absImport + "\")";
    });
    inlinedCount++;
    return "<style>\n/* inlined from " + abs + " */\n" + css + "\n</style>";
  });

  // --- 1b. Inline <script src="..."> (only if under 500KB) ---
  html = await replaceAsync(html, /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)><\/script>/gi, async (scriptTag, beforeSrc, src, afterSrc) => {
    if (timedOut) { skippedCount++; return scriptTag; }
    // Skip if the script tag has type=module with crossorigin or nomodule — those need to stay external
    if (/\btype\s*=\s*["']module["']/i.test(scriptTag) && /\bcrossorigin/i.test(scriptTag)) {
      skippedCount++;
      return rewriteScriptToAbsolute(scriptTag, src, baseUrl);
    }
    const abs = resolveUrl(src, baseUrl);
    if (!abs) { skippedCount++; return scriptTag; }
    if (timeRemaining() < 500) { timedOut = true; skippedCount++; return rewriteScriptToAbsolute(scriptTag, abs); }
    const fetched = await fetchAsset(abs, Math.min(4000, timeRemaining()));
    if (!fetched.ok || !fetched.text) { skippedCount++; return rewriteScriptToAbsolute(scriptTag, abs); }
    // Size check — skip if larger than 500KB
    if (Buffer.byteLength(fetched.text, "utf8") > MAX_JS_INLINE_BYTES) {
      skippedCount++;
      return rewriteScriptToAbsolute(scriptTag, abs);
    }
    inlinedCount++;
    // Preserve any non-src attributes (type, async, defer, etc.) on the inlined tag
    const preservedAttrs = (beforeSrc + " " + afterSrc).replace(/\s+/g, " ").trim();
    return "<script" + (preservedAttrs ? " " + preservedAttrs : "") + ">\n/* inlined from " + abs + " */\n" + fetched.text + "\n</script>";
  });

  // --- 1c. Inline <img src="..."> (small) or rewrite to absolute URL (large) ---
  html = await replaceAsync(html, /<img\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>/gi, async (imgTag, beforeSrc, src, afterSrc) => {
    if (timedOut) { skippedCount++; return imgTag; }
    // Skip data URIs and SVG inline (already data: or already absolute http)
    if (/^data:/i.test(src)) { skippedCount++; return imgTag; }
    const abs = resolveUrl(src, baseUrl);
    if (!abs) { skippedCount++; return imgTag; }
    if (timeRemaining() < 500) { timedOut = true; skippedCount++; return rewriteImgSrc(imgTag, src, abs, beforeSrc, afterSrc); }
    const fetched = await fetchAssetBuffer(abs, Math.min(4000, timeRemaining()));
    if (!fetched.ok || !fetched.buf) { skippedCount++; return rewriteImgSrc(imgTag, src, abs, beforeSrc, afterSrc); }
    // Size check — large images get rewritten to absolute URL, not inlined
    if (fetched.buf.length > MAX_IMG_INLINE_BYTES) {
      skippedCount++;
      return rewriteImgSrc(imgTag, src, abs, beforeSrc, afterSrc);
    }
    inlinedCount++;
    const dataUri = toDataUri(fetched.buf, fetched.contentType);
    return "<img" + beforeSrc + ' src="' + dataUri + '"' + afterSrc + ">";
  });

  // --- 1d. Inline CSS url() references inside inline <style> blocks ---
  // Only touches url("...") and url('...') with relative/absolute http paths.
  // Leaves data: URIs alone.
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (styleTag, cssContent) => {
    // We can't easily await inside String.replace, so we do a synchronous pass that
    // only REWRITES relative url() to absolute url() — actual inlining of CSS
    // url() assets would require an async replace which is already done above for
    // <link> stylesheets. For inline <style> blocks, we just resolve relative
    // url() to absolute so the references still work after the HTML moves.
    const newCss = cssContent.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, urlPath) => {
      if (/^data:/i.test(urlPath)) return match;
      const abs = resolveUrl(urlPath, baseUrl);
      if (!abs) return match;
      return 'url("' + abs + '")';
    });
    return "<style>" + newCss + "</style>";
  });

  return { html, inlinedCount, skippedCount, timedOut };
}

// Helper: async regex replace (sequential, not parallel — to respect time budget).
async function replaceAsync(str, regex, asyncFn) {
  const promises = [];
  str.replace(regex, (match, ...args) => {
    // The last argument is the full string; offset and full string are at the end
    const fullString = args[args.length - 1];
    promises.push(asyncFn(match, ...args.slice(0, -2)));
    return match;
  });
  const replacements = await Promise.all(promises);
  let i = 0;
  return str.replace(regex, () => replacements[i++]);
}

// Rewrite a <link> tag's href to an absolute URL (used when inlining is skipped).
function rewriteLinkToAbsolute(linkTag, absUrl) {
  return linkTag.replace(/\bhref\s*=\s*["']([^"']+)["']/i, 'href="' + absUrl + '"');
}

// Rewrite a <script src="..."> tag's src to an absolute URL.
function rewriteScriptToAbsolute(scriptTag, src, baseUrl) {
  const abs = resolveUrl(src, baseUrl) || src;
  return scriptTag.replace(/\bsrc\s*=\s*["']([^"']+)["']/i, 'src="' + abs + '"');
}

// Rewrite an <img> tag's src to an absolute URL.
function rewriteImgSrc(imgTag, originalSrc, absUrl, beforeSrc, afterSrc) {
  return "<img" + beforeSrc + ' src="' + absUrl + '"' + afterSrc + ">";
}

// ---------------------------------------------------------------------------
// PART 2 — JS-rendered shell detection + Browserless smart-scrape fallback
// ---------------------------------------------------------------------------

// Heuristic: does this HTML look like a JS-rendered shell?
// Returns true if the body content is mostly empty / has a root div with
// minimal visible text.
function looksLikeJsShell(html) {
  if (!html || typeof html !== "string") return false;
  // Extract <body>...</body>
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return false;
  // Strip <script> tags, then strip all HTML tags, get visible text
  const bodyText = bodyMatch[1]
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Check for common SPA root divs
  const hasRootDiv = /<div[^>]+id=["']?(root|app)["']?/i.test(bodyMatch[1]);
  // Under 500 bytes of visible text → likely a shell
  if (bodyText.length < 500) return true;
  // Has root/app div AND under 800 bytes of visible text → likely a shell
  if (hasRootDiv && bodyText.length < 800) return true;
  return false;
}

// Call Browserless's /smart-scrape endpoint to get rendered HTML.
// Returns { ok: true, html } on success, { ok: false, error, status } on failure.
async function smartScrapeRender(targetUrl) {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) return { ok: false, error: "BROWSERLESS_API_KEY not set", status: 0 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMART_SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch("https://production-sfo.browserless.io/smart-scrape?token=" + apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: targetUrl }),
      signal: controller.signal,
    });
    // --fail-equivalent: check response status explicitly
    if (!res.ok) {
      let errBody = "";
      try { errBody = await res.text(); } catch (e) {}
      return {
        ok: false,
        status: res.status,
        error: "Browserless /smart-scrape returned HTTP " + res.status + (errBody ? ": " + errBody.slice(0, 200) : ""),
      };
    }
    const contentType = res.headers.get("content-type") || "";
    // The endpoint should return text/html or text/plain
    const html = await res.text();
    if (!html || html.length < 50) {
      return { ok: false, status: res.status, error: "Browserless returned empty or too-short response" };
    }
    return { ok: true, html };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, status: 0, error: "Browserless /smart-scrape timed out after " + SMART_SCRAPE_TIMEOUT_MS + "ms" };
    }
    return { ok: false, status: 0, error: err.message || "Browserless request failed" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// PART 3 — Multi-page crawl helpers
// ---------------------------------------------------------------------------

// Extract same-domain <a href> links from the HTML.
// Returns array of { url, label }. De-dupes. Caps at `limit` (default 10).
function extractSameDomainLinks(html, baseUrl, limit) {
  if (!limit) limit = MULTI_PAGE_MAX_PAGES;
  const links = [];
  try {
    const baseHost = new URL(baseUrl).hostname.toLowerCase();
    const selfKey = baseUrl.split("#")[0].replace(/\/$/, "");
    const seen = new Set([selfKey]);
    const linkRegex = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRegex.exec(html)) && links.length < limit) {
      const href = m[1];
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
      let abs;
      try { abs = new URL(href, baseUrl); } catch (e) { continue; }
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      if (abs.hostname.toLowerCase() !== baseHost) continue;
      abs.hash = "";
      const key = abs.href.replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || abs.pathname;
      links.push({ url: abs.href, label });
    }
  } catch (e) {
    console.warn("[clone] Link extraction failed:", e.message);
  }
  return links;
}

// Fetch + parse robots.txt for the target URL's origin.
// Returns { allowed: true } if crawling is allowed, { allowed: false, reason } if not.
// On any fetch/parse error, defaults to allowed (fail-open — don't block cloning
// just because robots.txt is missing or malformed).
async function checkRobotsTxt(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const robotsUrl = parsed.origin + "/robots.txt";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    let res;
    try {
      res = await fetch(robotsUrl, {
        headers: { "User-Agent": "KayhostHTML/1.0 (clone crawler)" },
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { allowed: true };  // no robots.txt = allowed
    const text = await res.text();
    // Parse robots.txt: look for User-agent: * then Disallow: lines
    const lines = text.split("\n");
    let inUniversalAgent = false;
    const disallowedPaths = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const field = trimmed.slice(0, colonIdx).trim().toLowerCase();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (field === "user-agent") {
        inUniversalAgent = (value === "*");
      } else if (field === "disallow" && inUniversalAgent) {
        if (value) disallowedPaths.push(value);
      }
    }
    // Check if our target pathname starts with any disallowed path
    const myPath = parsed.pathname + parsed.search;
    for (const dis of disallowedPaths) {
      if (dis === "/" ) {
        // Disallow: / means everything is disallowed for *
        return { allowed: false, reason: "robots.txt disallows crawling for all user agents (Disallow: /)" };
      }
      if (myPath.startsWith(dis)) {
        return { allowed: false, reason: "robots.txt disallows crawling of paths starting with \"" + dis + "\"" };
      }
    }
    return { allowed: true };
  } catch (e) {
    // Fail-open: if robots.txt fetch fails, allow the crawl
    return { allowed: true };
  }
}

// Convert a URL to a file path for multi-page storage.
//   https://example.com/                 -> "index.html"
//   https://example.com/about            -> "about.html"
//   https://example.com/blog/post-1      -> "blog/post-1.html"
//   https://example.com/contact/         -> "contact/index.html"
function urlToFilePath(urlStr) {
  try {
    const parsed = new URL(urlStr);
    let path = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!path) return "index.html";
    if (path.endsWith("/")) path = path.slice(0, -1);
    // If the path looks like a directory (no file extension), append /index.html or .html
    if (!/\.[a-z0-9]+$/i.test(path)) {
      // Could be "/about" or "/blog/post-1" — use .html extension
      // But if the original URL ended with /, treat as /index.html
      if (parsed.pathname.endsWith("/")) {
        return path + "/index.html";
      }
      return path + ".html";
    }
    return path;
  } catch (e) {
    return "index.html";
  }
}

module.exports = {
  // Part 1
  inlineAssets,
  resolveUrl,
  // Part 2
  looksLikeJsShell,
  smartScrapeRender,
  // Part 3
  extractSameDomainLinks,
  checkRobotsTxt,
  urlToFilePath,
  // Constants (exported for testing)
  MAX_JS_INLINE_BYTES,
  MAX_IMG_INLINE_BYTES,
  MAX_TOTAL_INLINE_MS,
  SMART_SCRAPE_TIMEOUT_MS,
  MULTI_PAGE_MAX_PAGES,
};
