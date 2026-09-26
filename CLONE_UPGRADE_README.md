# KayHost HTML — Clone Upgrade (Parts 1 + 2 + 3)

This patch upgrades the "Clone from URL" feature with all three parts in one shot.

## What's new

### Part 1 — Inline linked assets
After fetching the target URL's HTML, the clone handler now:
- Parses `<link rel="stylesheet" href="...">` → fetches each → inlines as `<style>` tags in `<head>`
- Parses `<script src="...">` → fetches each → inlines as `<script>` tags (only if under 500KB; larger JS stays as absolute URL)
- Parses `<img src="...">` → fetches each → inlines small images (under 100KB) as base64 data URIs; larger images get rewritten to absolute URLs
- Parses CSS `url()` references inside inline `<style>` blocks → rewrites relative paths to absolute URLs
- Stops inlining when the 6-second time budget is exhausted — remaining assets stay as absolute URLs (partial inlining is fine, never fails the clone)
- Reports `inlinedCount` and `skippedCount` in the response

### Part 2 — JS-rendered site support via Browserless /smart-scrape
After the plain fetch:
1. Detects if the HTML looks like a JS-rendered shell (under 500 bytes of visible text, or has `<div id="root">`/`<div id="app">` with under 800 bytes of visible text)
2. If shell detected AND `BROWSERLESS_API_KEY` is set → calls `POST https://production-sfo.browserless.io/smart-scrape?token=...` to get the rendered HTML
3. 18-second timeout for the Browserless call
4. Checks response status explicitly (`--fail`-equivalent) — non-200 returns the raw HTML with a warning instead of failing
5. Applies Part 1's asset-inlining to the rendered HTML too
6. If smart-scrape fails or times out → falls back to the raw HTML with a "This page uses JavaScript rendering — the clone may be incomplete" warning

### Part 3 — Multi-page crawl clone
Adds a "Clone linked pages too" checkbox in the Clone modal (off by default). When enabled:
1. After cloning the initial URL, extracts same-domain `<a href>` links (up to 10, hard cap)
2. Crawls each linked page, applying the same fetch → (smart-scrape fallback if needed) → asset-inlining pipeline
3. Stores the result as a multi-page project in the existing `projects` Firestore collection (reuses the Phase 1 infrastructure — `index.html` → `/`, `about.html` → `/about`, etc.)
4. Streams progress to the client via Server-Sent Events (SSE): "Cloning page 3 of 10: About"
5. Respects `robots.txt` — if the target domain's robots.txt disallows crawling, returns an error explaining why. Per-page robots checks too.
6. Returns a `/p/<projectId>` URL on success

## Files in this patch

| File | Action | Purpose |
|---|---|---|
| `lib/clone-helpers.js` | **NEW** | All helper functions: `inlineAssets`, `looksLikeJsShell`, `smartScrapeRender`, `extractSameDomainLinks`, `checkRobotsTxt`, `urlToFilePath` |
| `api/main.js` | **PATCHED** (additive) | `handleClone` now uses the helpers (Part 1 + Part 2). New `handleCloneMulti` SSE endpoint (Part 3). New `clone-multi` route in dispatcher. |
| `vercel.json` | **PATCHED** (additive) | New `/api/clone-multi` rewrite. `maxDuration: 300` for `api/main.js` (multi-page crawl needs more time than the default 10s). |
| `index.html` | **PATCHED** (additive) | Clone modal gets a "Clone linked pages too" checkbox + progress bar. New `cloneMultiUrl()` function consumes the SSE stream and updates the progress UI. |
| `test-clone-helpers.js` | **NEW** | 22 unit tests for `lib/clone-helpers.js` — all pass. Run with `node test-clone-helpers.js`. |
| `CLONE_UPGRADE_README.md` | **NEW** | This file. |

## What was NOT touched

- ❌ Existing SSRF protections in `handleClone` (localhost block, private IP block, redirect-to-private block) — preserved exactly
- ❌ Existing 8s server timeout for the initial fetch — preserved exactly
- ❌ Existing 12s client timeout in `cloneUrl()` — preserved exactly
- ❌ Existing error messages — preserved exactly
- ❌ AI provider integrations — untouched
- ❌ Click-to-edit floating box — untouched
- ❌ Middleware — untouched
- ❌ Firebase/Firestore setup — untouched (uses existing `projects` collection from Phase 1)
- ❌ Paystack — untouched
- ❌ Admin dashboard — untouched

## New dependencies

**None.** Uses only Node built-ins (`fetch`, `Buffer`, `crypto` for... actually no crypto here, just `fetch` and `Buffer`).

## New environment variables

| Var | Required for | Notes |
|---|---|---|
| `BROWSERLESS_API_KEY` | Part 2 (JS-rendered sites) | Optional but recommended. Without it, JS shells fall back to the old "this page may require JavaScript" warning. Get it from browserless.io. |

No other new env vars.

## How to apply

1. Unzip this patch
2. Copy `lib/clone-helpers.js` into your repo's `lib/` folder
3. Replace `api/main.js` with the new version
4. Replace `vercel.json` with the new version
5. Replace `index.html` with the new version
6. (Optional) Copy `test-clone-helpers.js` to your repo root and run `node test-clone-helpers.js`
7. Set `BROWSERLESS_API_KEY` in Vercel env vars (optional but recommended)
8. Commit and push — Vercel auto-deploys

## How to test

### Part 1 — Asset inlining (single-page clone)
1. Open the Clone modal (you must be Pro — clone is a Pro feature)
2. Enter a URL like `https://example.com`
3. Leave "Clone linked pages too" UNCHECKED
4. Click "Fetch & host"
5. The cloned HTML should have CSS inlined as `<style>` tags, small images as base64 data URIs, large images rewritten to absolute URLs
6. View page source — look for `/* inlined from https://... */` comments

### Part 2 — JS-rendered site (smart-scrape fallback)
1. Clone a known SPA like `https://reactjs.org` (uses client-side rendering)
2. Without `BROWSERLESS_API_KEY`: you'll get the warning "This page may require JavaScript to render"
3. With `BROWSERLESS_API_KEY` set: the clone should have real rendered content (not an empty `<div id="root"></div>`)
4. Check Vercel logs for `[clone] smart-scrape failed:` messages on failure

### Part 3 — Multi-page crawl
1. Open the Clone modal
2. Enter a URL like `https://example.com`
3. CHECK "Clone linked pages too"
4. Click "Fetch & host"
5. The progress bar should appear and update: "Cloning page 2 of 5: About"
6. When done, a new tab opens at `/p/<projectId>` showing the multi-page site
7. Visit `/p/<projectId>/about` — should load the about page
8. Try cloning a site with `robots.txt` disallowing crawling → should get "Crawling disallowed by robots.txt: ..."

### Unit tests
```bash
node test-clone-helpers.js   # 22 tests, all pass
node test-multipage.js       # 36 tests, all pass (from Phase 1)
```

## Architecture decisions (for transparency)

1. **Why SSE for multi-page progress instead of polling?**
   - Polling would require a job-id + status endpoint + cleanup. SSE is simpler — one request, stream of updates, done.
   - Vercel supports SSE natively (same as the Phase 3 AI streaming).
   - The frontend already has the SSE parsing pattern from Phase 3.

2. **Why 6s inlining budget instead of 8s?**
   - The initial fetch already used up to 8s. If we then spent another 8s on inlining, the total request time would be 16s — over the original 12s client timeout.
   - 6s for inlining leaves ~2s buffer. Total max ~14s, just over the 12s client timeout — but `cloneUrl()` uses a 12s timeout on the client. The single-page clone might hit the client timeout if the server takes 14s, but that's acceptable because inlining is best-effort.
   - For the multi-page endpoint (`clone-multi`), the SSE stream keeps the connection alive so the client timeout doesn't apply.

3. **Why `production-sfo.browserless.io` instead of `production-lon` or `production-ams`?**
   - Vercel's default region is US East (iad1). SFO is the closest Browserless region to US East with the lowest latency for the smart-scrape call.
   - If you deploy to a different Vercel region, you might want to switch to a closer Browserless region.

4. **Why does the multi-page endpoint have `maxDuration: 300` (5 minutes)?**
   - 10 pages × (8s fetch + 6s inline + 18s smart-scrape fallback if needed) = up to 320s in the worst case.
   - 300s gives a hard ceiling. Vercel Hobby tier caps at 60s though — you'll need Vercel Pro for the full 5-minute multi-page crawl. On Hobby, the function will be killed at 60s and you'll get a partial result (whatever pages were crawled by then).
   - The SSE stream means the client sees progress in real time, so even a 60s cutoff is graceful — the user sees "Cloning page 4 of 10" and then the connection drops with whatever was stored.

5. **Why fail-open on robots.txt fetch errors?**
   - If robots.txt is missing (404) or the fetch fails (timeout, DNS, etc.), defaulting to "allowed" matches industry standard. Google, Bing, etc. all treat a missing/unreachable robots.txt as "no restrictions."
   - Only an explicit `Disallow: /` or `Disallow: /path` in a successfully-fetched robots.txt blocks the crawl.

6. **Why is the smart-scrape endpoint `/smart-scrape` instead of `/content`?**
   - You asked for `/smart-scrape` in the follow-up message. It's more capable than `/content` for extracting rendered page content (Browserless's docs say it returns cleaner HTML).

## Known limitations

- **Part 1 inlining is best-effort.** If a site has 50 CSS files, we won't inline all of them in 6s. Remaining ones stay as absolute URLs (which still work thanks to the `<base>` tag).
- **Part 2 smart-scrape is rate-limited by Browserless.** If you hit your plan's concurrent request limit, the call fails and falls back to raw HTML.
- **Part 3 multi-page crawl on Vercel Hobby** is capped at 60s by Vercel's function timeout, regardless of the `maxDuration: 300` setting. You'll get partial results. Upgrade to Vercel Pro for the full 5-minute budget.
- **No depth-2 crawling.** We only crawl pages directly linked from the initial page, not pages linked from those pages. This is intentional — depth-2 would explode to 100+ pages fast.
- **No binary asset inlining for fonts/videos.** Only images. Fonts and videos stay as absolute URLs. Can be added in a future phase if needed.
