// lib/clone-helpers.js — asset inlining + JS-rendered shell detection +
// Browserless smart-scrape fallback + multi-page crawl helpers.
//
// Used by api/main.js handleClone + handleCloneMulti (the SSE multi-page endpoint).
// 100% additive — handleClone's existing SSRF / timeout / error-message behavior
// is preserved exactly. These helpers only run AFTER the existing fetch succeeds.

const MAX_JS_INLINE_BYTES = 500 * 1024;     // 500KB — JS files larger than this stay as <script src="...">
const MAX_TOTAL_INLINE_MS = 6000;           // 6s budget for inlining (leaves ~2s of the 8s total for the initial fetch)
const SMART_SCRAPE_TIMEOUT_MS = 18000;      // 18s for Browserless (rendering is slower than plain fetch)
const MULTI_PAGE_MAX_PAGES = 10;            // hard cap on additional pages crawled

// Asset limits (Grok's recommendations)
const MAX_ASSETS_PER_CLONE = 500;           // max total binary assets discovered per clone
const MAX_ASSET_SIZE_BYTES = 20 * 1024 * 1024;  // 20MB per individual asset
const MAX_TOTAL_ASSET_BYTES = 50 * 1024 * 1024; // 50MB total binary assets per clone

// Cloudinary config (same as api/main.js — hardcoded for the project)
const CLOUDINARY_CLOUD_NAME = "dbmtqgs3v";
const CLOUDINARY_UPLOAD_PRESET = "kayhost";

// Cache of already-uploaded assets (url → cloudinaryUrl) to avoid re-uploading the same asset
// when it appears on multiple pages of a multi-page clone
const _cloudinaryCache = new Map();

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

// Convert a Buffer to a base64 data URI (kept for backwards compat, but no longer
// used for images/fonts — those go to Cloudinary now).
function toDataUri(buf, contentType) {
  return "data:" + (contentType || "application/octet-stream") + ";base64," + buf.toString("base64");
}

// Upload a binary asset to Cloudinary and return the permanent URL.
// Uses the same upload preset as the Media Library feature.
// Returns { ok: true, url } on success, { ok: false, error } on failure.
async function uploadToCloudinary(buf, contentType, originalUrl) {
  // Check if we already uploaded this asset (cache hit)
  if (originalUrl && _cloudinaryCache.has(originalUrl)) {
    return { ok: true, url: _cloudinaryCache.get(originalUrl), cached: true };
  }

  // Check size limits
  if (buf.length > MAX_ASSET_SIZE_BYTES) {
    return { ok: false, error: "Asset too large (" + buf.length + " bytes, max " + MAX_ASSET_SIZE_BYTES + ")" };
  }

  try {
    const dataUri = "data:" + (contentType || "application/octet-stream") + ";base64," + buf.toString("base64");
    const cloudinaryUrl = "https://api.cloudinary.com/v1_1/" + CLOUDINARY_CLOUD_NAME + "/auto/upload";
    const formData = new (require("url").URLSearchParams)();
    formData.append("file", dataUri);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);  // 10s timeout for Cloudinary upload
    const uploadRes = await fetch(cloudinaryUrl, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => "unknown");
      return { ok: false, error: "Cloudinary HTTP " + uploadRes.status + ": " + errText.slice(0, 100) };
    }
    const result = await uploadRes.json();
    if (!result.secure_url) {
      return { ok: false, error: "Cloudinary returned no URL" };
    }
    // Cache the result
    if (originalUrl) _cloudinaryCache.set(originalUrl, result.secure_url);
    return { ok: true, url: result.secure_url };
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, error: "Cloudinary upload timed out" };
    return { ok: false, error: err.message || "Cloudinary upload failed" };
  }
}

// Fetch a binary asset with retry (1 retry with 500ms backoff for rate-limited servers).
// Returns { ok, buf, contentType } or { ok: false, error }.
async function fetchAssetBufferWithRetry(url, timeoutMs) {
  const first = await fetchAssetBuffer(url, timeoutMs);
  if (first.ok) return first;
  // Retry once after 500ms backoff (only for 429 or network errors, not 404)
  if (first.status === 429 || first.status === 0 || first.status === 503) {
    console.log("[inline] Retrying after 429/503/network error:", url);
    await new Promise(r => setTimeout(r, 500));
    const retry = await fetchAssetBuffer(url, timeoutMs);
    if (retry.ok) {
      console.log("[inline] Retry succeeded:", url);
      return retry;
    }
    console.log("[inline] Retry also failed:", url, "->", retry.error);
    return retry;
  }
  return first;
}

// Track asset stats for the summary
function createAssetStats() {
  return {
    assetsFound: 0,
    assetsUploaded: 0,
    assetsInlined: 0,  // CSS/JS text inlined (not binary)
    assetsFailed: 0,
    assetsSkipped: 0,
    totalBytesUploaded: 0,
    failedUrls: [],
  };
}

// Inline linked CSS, JS, image, and font assets into an HTML string.
// Binary assets (images, fonts) are uploaded to Cloudinary instead of base64-inlined.
// CSS/JS text is inlined as before (no bloat problem with text).
// Stops inlining when the total elapsed time exceeds `deadlineMs`.
//
// Returns { html, inlinedCount, skippedCount, timedOut, assetStats }.
async function inlineAssets(html, baseUrl, deadlineMs) {
  if (!html || typeof html !== "string") return { html, inlinedCount: 0, skippedCount: 0, timedOut: false, assetStats: createAssetStats() };
  const startMs = Date.now();
  let inlinedCount = 0;
  let skippedCount = 0;
  let timedOut = false;
  const stats = createAssetStats();

  function timeRemaining() {
    return deadlineMs - (Date.now() - startMs);
  }

  // --- 1a. Inline <link rel="stylesheet" href="..."> --- (CSS text, still inlined)
  html = await replaceAsync(html, /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi, async (linkTag) => {
    if (timedOut) { skippedCount++; return linkTag; }
    const hrefMatch = linkTag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) { skippedCount++; return linkTag; }
    const abs = resolveUrl(hrefMatch[1], baseUrl);
    if (!abs) { skippedCount++; return linkTag; }
    if (timeRemaining() < 500) { timedOut = true; skippedCount++; console.log("[inline] CSS timeout-skip:", abs); return rewriteLinkToAbsolute(linkTag, abs); }
    console.log("[inline] CSS fetch:", abs);
    const fetched = await fetchAsset(abs, Math.min(4000, timeRemaining()));
    if (!fetched.ok || !fetched.text) {
      skippedCount++;
      console.log("[inline] CSS FAILED:", abs, "->", fetched.error || ("HTTP " + fetched.status));
      return rewriteLinkToAbsolute(linkTag, abs);
    }
    let css = fetched.text;
    css = css.replace(/@import\s+(?:url\(["']?|["'])([^"')]+)["']?\)?/gi, (match, importPath) => {
      const absImport = resolveUrl(importPath, abs);
      if (!absImport) return match;
      return "@import url(\"" + absImport + "\")";
    });
    inlinedCount++;
    stats.assetsInlined++;
    console.log("[inline] CSS OK:", abs, "(" + css.length + " bytes)");
    return "<style>\n/* inlined from " + abs + " */\n" + css + "\n</style>";
  });

  // --- 1b. Inline <script src="..."> (only if under 500KB) --- (JS text, still inlined)
  html = await replaceAsync(html, /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)><\/script>/gi, async (scriptTag, beforeSrc, src, afterSrc) => {
    if (timedOut) { skippedCount++; return scriptTag; }
    if (/\btype\s*=\s*["']importmap["']/i.test(scriptTag)) {
      skippedCount++;
      console.log("[inline] JS skip (importmap):", src);
      return rewriteScriptToAbsolute(scriptTag, src, baseUrl);
    }
    if (/\btype\s*=\s*["']module["']/i.test(scriptTag) && /\bcrossorigin/i.test(scriptTag)) {
      skippedCount++;
      console.log("[inline] JS skip (module+crossorigin):", src);
      return rewriteScriptToAbsolute(scriptTag, src, baseUrl);
    }
    const abs = resolveUrl(src, baseUrl);
    if (!abs) { skippedCount++; return scriptTag; }
    if (timeRemaining() < 500) { timedOut = true; skippedCount++; console.log("[inline] JS timeout-skip:", abs); return rewriteScriptToAbsolute(scriptTag, abs); }
    console.log("[inline] JS fetch:", abs);
    const fetched = await fetchAsset(abs, Math.min(4000, timeRemaining()));
    if (!fetched.ok || !fetched.text) {
      skippedCount++;
      console.log("[inline] JS FAILED:", abs, "->", fetched.error || ("HTTP " + fetched.status));
      return rewriteScriptToAbsolute(scriptTag, abs);
    }
    if (Buffer.byteLength(fetched.text, "utf8") > MAX_JS_INLINE_BYTES) {
      skippedCount++;
      console.log("[inline] JS skip (too large):", abs, "(" + fetched.text.length + " bytes)");
      return rewriteScriptToAbsolute(scriptTag, abs);
    }
    inlinedCount++;
    stats.assetsInlined++;
    console.log("[inline] JS OK:", abs, "(" + fetched.text.length + " bytes)");
    const preservedAttrs = (beforeSrc + " " + afterSrc)
      .replace(/\btype\s*=\s*["']importmap["']/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    return "<script" + (preservedAttrs ? " " + preservedAttrs : "") + ">\n/* inlined from " + abs + " */\n" + fetched.text + "\n</script>";
  });

  // --- 1c. Upload <img src="..."> to Cloudinary (instead of base64 inlining) ---
  html = await replaceAsync(html, /<img\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>/gi, async (imgTag, beforeSrc, src, afterSrc) => {
    if (timedOut) { skippedCount++; stats.assetsSkipped++; return imgTag; }
    if (/^data:/i.test(src)) { skippedCount++; return imgTag; }
    const abs = resolveUrl(src, baseUrl);
    if (!abs) { skippedCount++; stats.assetsSkipped++; return imgTag; }
    stats.assetsFound++;
    if (stats.assetsFound > MAX_ASSETS_PER_CLONE) { skippedCount++; stats.assetsSkipped++; return rewriteImgSrc(imgTag, src, abs, beforeSrc, afterSrc); }
    if (timeRemaining() < 500) { timedOut = true; skippedCount++; stats.assetsSkipped++; console.log("[inline] IMG timeout-skip:", abs); return rewriteImgSrc(imgTag, src, abs, beforeSrc, afterSrc); }
    console.log("[inline] IMG fetch:", abs);
    const fetched = await fetchAssetBufferWithRetry(abs, Math.min(4000, timeRemaining()));
    if (!fetched.ok || !fetched.buf) {
      skippedCount++;
      stats.assetsFailed++;
      stats.failedUrls.push(abs);
      console.log("[inline] IMG FAILED:", abs, "->", fetched.error || ("HTTP " + fetched.status));
      // Rewrite to absolute URL (best-effort — the image might still load from the original domain)
      return rewriteImgSrc(imgTag, src, abs, beforeSrc, afterSrc);
    }
    if (fetched.buf.length > MAX_ASSET_SIZE_BYTES) {
      skippedCount++;
      stats.assetsSkipped++;
      console.log("[inline] IMG skip (too large):", abs, "(" + fetched.buf.length + " bytes)");
      return rewriteImgSrc(imgTag, src, abs, beforeSrc, afterSrc);
    }
    if (stats.totalBytesUploaded + fetched.buf.length > MAX_TOTAL_ASSET_BYTES) {
      skippedCount++;
      stats.assetsSkipped++;
      console.log("[inline] IMG skip (total limit reached):", abs);
      return rewriteImgSrc(imgTag, src, abs, beforeSrc, afterSrc);
    }
    // Upload to Cloudinary instead of base64 inlining
    console.log("[inline] IMG upload to Cloudinary:", abs, "(" + fetched.buf.length + " bytes)");
    const uploaded = await uploadToCloudinary(fetched.buf, fetched.contentType, abs);
    if (uploaded.ok && uploaded.url) {
      inlinedCount++;
      stats.assetsUploaded++;
      stats.totalBytesUploaded += fetched.buf.length;
      console.log("[inline] IMG Cloudinary OK:", abs, "->", uploaded.url + (uploaded.cached ? " (cached)" : ""));
      return "<img" + beforeSrc + ' src="' + uploaded.url + '"' + afterSrc + ">";
    } else {
      skippedCount++;
      stats.assetsFailed++;
      stats.failedUrls.push(abs);
      console.log("[inline] IMG Cloudinary FAILED:", abs, "->", uploaded.error);
      return rewriteImgSrc(imgTag, src, abs, beforeSrc, afterSrc);
    }
  });

  // --- 1d. Upload CSS url() binary assets (fonts, images) to Cloudinary ---
  // Instead of base64 inlining (which bloats Firestore docs past 1MB),
  // upload each font/image to Cloudinary and rewrite the url() to the Cloudinary URL.
  html = await replaceAsync(html, /<style\b[^>]*>([\s\S]*?)<\/style>/gi, async (styleTag, cssContent) => {
    if (timedOut) return styleTag;
    const newCss = await replaceAsync(cssContent, /url\(\s*["']?([^"')]+)["']?\s*\)/gi, async (urlMatch, urlPath) => {
      if (/^data:/i.test(urlPath)) return urlMatch;  // already a data URI
      const abs = resolveUrl(urlPath, baseUrl);
      if (!abs) return urlMatch;
      if (timedOut) return 'url("' + abs + '")';
      stats.assetsFound++;
      if (stats.assetsFound > MAX_ASSETS_PER_CLONE) return 'url("' + abs + '")';
      // Fetch the binary asset with retry
      console.log("[inline] CSS url() fetch:", abs);
      const fetched = await fetchAssetBufferWithRetry(abs, Math.min(3000, timeRemaining()));
      if (!fetched.ok || !fetched.buf) {
        console.log("[inline] CSS url() FAILED:", abs, "->", fetched.error || ("HTTP " + fetched.status));
        stats.assetsFailed++;
        stats.failedUrls.push(abs);
        return 'url("' + abs + '")';  // fallback to absolute URL
      }
      if (fetched.buf.length > MAX_ASSET_SIZE_BYTES) {
        console.log("[inline] CSS url() skip (too large):", abs, "(" + fetched.buf.length + " bytes)");
        stats.assetsSkipped++;
        return 'url("' + abs + '")';
      }
      if (stats.totalBytesUploaded + fetched.buf.length > MAX_TOTAL_ASSET_BYTES) {
        stats.assetsSkipped++;
        return 'url("' + abs + '")';
      }
      // Upload to Cloudinary
      console.log("[inline] CSS url() upload to Cloudinary:", abs, "(" + fetched.buf.length + " bytes)");
      const uploaded = await uploadToCloudinary(fetched.buf, fetched.contentType, abs);
      if (uploaded.ok && uploaded.url) {
        inlinedCount++;
        stats.assetsUploaded++;
        stats.totalBytesUploaded += fetched.buf.length;
        console.log("[inline] CSS url() Cloudinary OK:", abs, "->", uploaded.url + (uploaded.cached ? " (cached)" : ""));
        return 'url("' + uploaded.url + '")';
      } else {
        stats.assetsFailed++;
        stats.failedUrls.push(abs);
        console.log("[inline] CSS url() Cloudinary FAILED:", abs, "->", uploaded.error);
        return 'url("' + abs + '")';
      }
    });
    return "<style>" + newCss + "</style>";
  });

  return { html, inlinedCount, skippedCount, timedOut, assetStats: stats };
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
  uploadToCloudinary,
  createAssetStats,
  // Part 2
  looksLikeJsShell,
  smartScrapeRender,
  // Part 3
  extractSameDomainLinks,
  checkRobotsTxt,
  urlToFilePath,
  // Constants (exported for testing)
  MAX_JS_INLINE_BYTES,
  MAX_TOTAL_INLINE_MS,
  SMART_SCRAPE_TIMEOUT_MS,
  MULTI_PAGE_MAX_PAGES,
  MAX_ASSETS_PER_CLONE,
  MAX_ASSET_SIZE_BYTES,
  MAX_TOTAL_ASSET_BYTES,
};
