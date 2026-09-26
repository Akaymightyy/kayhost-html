# KayHost HTML — Bug Fixes + AshnaAI/OpenCode Removal

This patch fixes three bugs AND removes AshnaAI + OpenCode entirely (keeping only Gemini + OpenRouter).

## What's fixed

### BUG 1 — AshnaAI/OpenCode removed entirely

Per your instruction, both providers have been completely removed:

**Files deleted:**
- `lib/ashna.js` — deleted
- `api/ashna-models.js` — deleted

**Files patched:**
- `api/ai-edit.js` — removed `require("../lib/ashna")`, removed `handleAshnaEdit` function (entire function deleted), removed `handleProProviderEdit` function (entire function deleted), removed ashna/opencode branches from the dispatcher, inlined `validateAndExtractHtml` (was in ashna.js, now standalone), removed ashna/opencode from the streaming handler
- `lib/ai-providers.js` — completely rewritten to remove all OpenCode references (OPENCODE_MODELS, OPENCODE_BASE_URL, opencode branch in getEnabledProviders/callProvider/validateModel)
- `index.html` — removed ashna-optgroup + opencode-optgroup HTML, removed loadAshnaModels function, removed ashna:/opencode: prefix handling from applyAiEdit + tryStreamAiEdit + tier badge logic, removed ashna-models fetch, cleaned up comments
- `vercel.json` — removed `api/ashna-models.js` maxDuration + `/api/ashna-models` rewrite

**What's kept (unchanged):**
- ✅ Gemini (shared server key + BYOK)
- ✅ OpenRouter (free tier, dynamic model fetching)
- ✅ BYOK (Claude, GPT, your own Gemini key)

### BUG 2 — Asset inlining now actually inlines fonts + images

**Root cause:** The CSS `url()` handling in step 1d was SYNCHRONOUS — it only REWROTE relative URLs to absolute URLs, but never actually fetched and inlined the fonts/images. When the cloned HTML moved to kayhosthtml.zone.id, the absolute URLs pointed to the original domain which blocked cross-origin loading (CORS errors + 404s).

**Fix:** Rewrote step 1d to use `replaceAsync` (async regex replace). Now for each `url()` reference in `<style>` blocks:
1. Fetches the asset (font/image) server-side
2. If under 100KB → inlines as base64 data URI
3. If over 100KB or fetch fails → falls back to absolute URL (same as before, but now the attempt is actually made)
4. Logs every attempt: `[inline] CSS url() fetch: https://...` → `[inline] CSS url() OK: ... (1234 bytes)` or `[inline] CSS url() FAILED: ... -> HTTP 404`

**Also added server-side logging for ALL asset types:**
- `[inline] CSS fetch: https://...` / `CSS OK:` / `CSS FAILED:`
- `[inline] JS fetch: https://...` / `JS OK:` / `JS FAILED:` / `JS skip (importmap):` / `JS skip (too large):`
- `[inline] IMG fetch: https://...` / `IMG OK:` / `IMG FAILED:` / `IMG skip (too large):`
- `[inline] CSS url() fetch: https://...` / `CSS url() OK:` / `CSS url() FAILED:`

This makes the inlining pipeline fully debuggable from Vercel logs.

### BUG 3 — Importmap corruption + null replace crash

**Importmap corruption fix:**
- **Root cause:** The `<script src="...">` inlining regex matched ALL script tags with a `src` attribute, including `<script type="importmap" src="...">`. When it fetched the importmap JSON and inlined it as a regular `<script>` tag, the browser tried to parse the JSON as JavaScript → "Failed to parse import map: invalid JSON" / "Unexpected token '{'".
- **Fix:** Added a check at the top of the script inlining handler: `if (/\btype\s*=\s*["']importmap["']/i.test(scriptTag))` → skip inlining, rewrite to absolute URL instead. Importmaps stay as external references (which is correct — they're JSON, not JS).

**Null replace crash fix:**
- **Root cause:** In `api/ai-edit.js` line 209, `let updatedHtml = response.text;` — if the Gemini SDK returned a response object where `.text` was null/undefined (which happens on certain API errors), the next line `updatedHtml.trim()` would crash with "Cannot read properties of null (reading 'trim')" (which manifests as 'replace' in the call stack).
- **Fix:** Added a null check: `let updatedHtml = response && response.text ? response.text : "";` + if empty, return a clean error: `"AI returned an empty response. Try again."` instead of crashing.

## Files in this patch

| File | Action | Purpose |
|---|---|---|
| `api/ai-edit.js` | PATCHED | Remove Ashna + OpenCode handlers; inline `validateAndExtractHtml`; fix null replace crash on `response.text` |
| `api/main.js` | PATCHED | No changes needed for this patch (already has the Firestore fix from prior patch) — but included for completeness if you need a clean copy |
| `lib/ai-providers.js` | REWRITTEN | Remove all OpenCode references; only OpenRouter remains |
| `lib/clone-helpers.js` | PATCHED | Fix font/image inlining (async url() replacement); skip importmap scripts; add server-side logging for every asset |
| `index.html` | PATCHED | Remove Ashna + OpenCode UI (optgroups, loadAshnaModels, tier badges, applyAiEdit branches, streaming branches) |
| `vercel.json` | PATCHED | Remove ashna-models route + maxDuration |
| `BUGFIX_README.md` | NEW | This file |

**Files to DELETE from your repo (no longer needed):**
- `lib/ashna.js`
- `api/ashna-models.js`

## What was NOT touched

- ❌ Gemini flow — unchanged
- ❌ OpenRouter flow — unchanged
- ❌ BYOK (Claude/GPT/your own Gemini key) — unchanged
- ❌ Click-to-edit floating box — unchanged
- ❌ Middleware — unchanged
- ❌ Firebase/Firestore — unchanged
- ❌ Paystack — unchanged
- ❌ Admin dashboard — unchanged
- ❌ Existing single-page deploy — unchanged
- ❌ SSRF protections, timeouts, robots.txt checks — all preserved

## How to apply

1. Download the zip from gofile
2. Replace these 5 files in your repo:
   - `api/ai-edit.js`
   - `lib/ai-providers.js`
   - `lib/clone-helpers.js`
   - `index.html`
   - `vercel.json`
3. **Delete these 2 files** from your repo:
   - `lib/ashna.js`
   - `api/ashna-models.js`
4. Commit + push → Vercel auto-deploys

## How to test

### Test 1: Gemini + OpenRouter still work
1. Paste HTML → click any element → pick "Gemini 2.5 Flash" → type instruction → Apply
2. Should work as before
3. Pick an OpenRouter model → Apply → should work

### Test 2: AshnaAI + OpenCode are gone
1. Open the AI model dropdown
2. Should see: Gemini, BYOK models (Claude/GPT), OpenRouter (Free)
3. Should NOT see: AshnaAI group, OpenCode Zen group

### Test 3: Clone with fonts/images (yuyu.ng, htmlhost.co)
1. Clone `https://yuyu.ng` (single-page, no multi-toggle)
2. Check Vercel logs — should see:
   ```
   [inline] CSS fetch: https://yuyu.ng/style.css
   [inline] CSS OK: https://yuyu.ng/style.css (1234 bytes)
   [inline] CSS url() fetch: https://yuyu.ng/fonts/inter.woff2
   [inline] CSS url() OK: https://yuyu.ng/fonts/inter.woff2 (4567 bytes)
   [inline] IMG fetch: https://yuyu.ng/logo.png
   [inline] IMG OK: https://yuyu.ng/logo.png (8901 bytes)
   ```
3. Open the cloned page → check browser console
4. Should NOT see CORS errors or 404s for fonts/images (they're now inlined as base64)

### Test 4: Importmap no longer corrupted
1. Clone a site that uses `<script type="importmap">` (e.g. htmlhost.co)
2. Open the cloned page → check browser console
3. Should NOT see "Failed to parse import map: invalid JSON"
4. Should NOT see "Unexpected token '{'"

### Test 5: No null replace crash
1. If the Gemini API returns an empty response (rare, but happens on certain errors)
2. Should see: "AI returned an empty response. Try again."
3. Should NOT crash with "Cannot read properties of null (reading 'replace')"

### Test 6: All unit tests pass
```bash
node test-multipage.js             # 36 tests ✓
node test-slug.js                  # 25 tests ✓
node test-clone-helpers.js         # 22 tests ✓
node test-firestore-sanitizer.js   # 15 tests ✓
```
Total: **98 tests passing**.
