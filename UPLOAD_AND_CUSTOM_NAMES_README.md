# KayHost HTML — Folder/Zip Upload + Custom Names

This patch ships two features in one zip:

1. **Folder + ZIP upload wiring** — connects the existing "Upload folder" and "Upload file" (for .zip) buttons to the Phase 1 multi-page backend. Both auto-deploy and redirect to the new `/p/<projectId>` link.

2. **Custom name/slug support** — users can choose a custom link like `kayhosthtml.zone.id/akaytech` instead of the random ID. Available to ALL users (free tier too).

## What was fixed/added

### Feature 1: Folder + ZIP upload

**Root cause of "folder upload does nothing":**
- The `<input type="file" id="folder-input" webkitdirectory multiple>` element was hidden with `style="display:none"`. Some browsers (especially mobile Safari) refuse to open the file picker when `.click()` is called on a `display:none` input.
- **Fix:** Changed to `style="position:absolute;left:-9999px;top:0;width:1px;height:1px;opacity:0;"` — the input is off-screen but still in the render tree, so `.click()` works reliably on all browsers.

**Root cause of "ZIP upload shows Coming soon":**
- The zip handler in `handleFile()` just called `toast("ZIP upload coming soon", "error")` — no actual unzip logic existed.
- **Fix:** Added JSZip via CDN (`<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js">`). The handler now unzips client-side, builds a file-tree object, and deploys it.

**New flow (both folder + zip):**
1. User selects a folder (via folder picker) or a .zip file (via file picker)
2. Client reads all files, strips the top-level folder name (for folder uploads), builds `{ "index.html": "...", "about.html": "...", "css/style.css": "..." }`
3. Validates: at least 1 HTML file, total size under 10MB
4. POSTs to `/api/multi-deploy` (the existing Phase 1 backend)
5. On success, opens the new `/p/<projectId>` URL in a new tab + switches to "My Sites" view
6. On error, shows a clear toast message

**What's NOT touched:**
- The "Paste HTML" single-file flow — unchanged
- The Phase 1 backend (`handleMultiDeploy`, `handleMultiServe`) — unchanged
- The existing folder handler's old behavior (loading files into editor tabs) — replaced entirely with auto-deploy (the old behavior didn't actually deploy, so no regression)

### Feature 2: Custom name/slug

**Frontend:**
- New "Custom link (optional)" field in the deploy form, with a `kayhosthtml.zone.id/` prefix display
- Live validation as the user types (debounced 400ms): checks format + availability via `/api/check-slug`
- Green "✓ available" or red error message below the input
- If left blank, the existing random-ID behavior is used (unchanged)

**Backend:**
- New `validateSlug()` function: lowercase letters, numbers, hyphens; 3–30 chars; no leading/trailing hyphens
- New `RESERVED_SLUGS` set: blocks ~50 reserved words (admin, api, settings, new, templates, etc.) so custom names can't collide with app routes
- New `checkSlugAvailability()` function: checks Firestore `sites` AND `projects` collections for existing `customName`
- `handleDeploy` now accepts optional `customName` in the request body — validates, checks uniqueness, stores on the site doc. Returns the custom-name URL (`/<slug>`) if set, otherwise the random-ID URL (`/site/<id>`)
- `handleMultiDeploy` same — stores `customName` on the project doc
- New `handleCheckSlug` route (GET `/api/check-slug?slug=...`) — returns `{ available: true }` or `{ available: false, error }`
- New `handleSiteResolve` route (GET `/api/site-resolve?slug=...`) — resolves a custom-name slug to its site/project HTML. If not found or reserved, serves the SPA HTML so the app's own routes still work.
- New `handleSiteUpdateName` route (POST `/api/site-update-name`) — lets the user edit/remove the custom name from "My Sites"
- `handleSites` now returns `customName` in each site object

**Routing:**
- New rewrite in `vercel.json`: `/:slug([a-z0-9][a-z0-9-]{1,28}[a-z0-9])` → `/api/main?route=site-resolve&slug=:slug`
- Placed BEFORE the SPA catch-all so custom names are resolved by the API
- The regex matches 3–30 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens — so it won't catch paths like `/admin` (5 chars, all lowercase — oops, it WOULD match). The `handleSiteResolve` handler checks reserved words and serves the SPA for them, so app routes still work.

**My Sites page:**
- Each site now shows a purple badge with the custom name if set (e.g. `/akaytech`)
- The "open" and "copy" buttons use the custom-name URL when set
- New "edit name" button — opens a prompt to change or remove the custom name

## Files in this patch

| File | Action | Purpose |
|---|---|---|
| `index.html` | PATCHED | Folder-input visibility fix; JSZip CDN; zip unzip + deploy; custom-name field + validation + availability check; deploy handler sends `customName`; My Sites shows custom-name badge + edit button |
| `api/main.js` | PATCHED (additive) | `validateSlug`, `checkSlugAvailability`, `RESERVED_SLUGS`; `handleDeploy` + `handleMultiDeploy` accept `customName`; new `handleCheckSlug`, `handleSiteResolve`, `handleSiteUpdateName`; `handleSites` returns `customName` |
| `vercel.json` | PATCHED (additive) | New `/api/check-slug`, `/api/site-resolve`, `/api/site-update-name` rewrites; new `/:slug` rewrite before SPA catch-all |
| `test-slug.js` | NEW | 25 unit tests for slug validation — all pass. Run with `node test-slug.js`. |
| `UPLOAD_AND_CUSTOM_NAMES_README.md` | NEW | This file. |

## What was NOT touched

- ❌ Existing random-ID deploy flow — unchanged (custom name is purely optional)
- ❌ AI provider integrations — untouched
- ❌ Click-to-edit floating box — untouched
- ❌ Middleware — untouched
- ❌ Firebase/Firestore setup — untouched (uses existing `sites` + `projects` collections, just adds a `customName` field)
- ❌ Paystack — untouched
- ❌ Admin dashboard — untouched

## New dependencies

- **JSZip** (CDN only, no npm install needed) — loaded from `https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js`. Used for client-side ZIP extraction. No build step required.

## Firestore changes

No new collections. The `sites` and `projects` collections get a new optional field:
```
customName: string | null  // e.g. "akaytech" or null
```

No Firestore rules changes needed — the existing `allow read: if true; allow create: if true;` on `sites` and `projects` covers the new field.

## How to apply

1. Download the zip from gofile
2. Replace these 3 files in your repo:
   - `index.html`
   - `api/main.js`
   - `vercel.json`
3. (Optional) Copy `test-slug.js` to repo root → `node test-slug.js` (25 tests pass)
4. Commit + push → Vercel auto-deploys

## How to test

### Folder upload
1. Create a local folder with `index.html` + `about.html` + `css/style.css`
2. Click "Upload folder" → select the folder
3. The browser's native folder picker opens (this was broken before)
4. Toast: "Reading folder (3 files)..." → "Deploying 3 files..." → "Deployed! 3 pages are live."
5. A new tab opens at `/p/<projectId>` showing the multi-page site
6. Visit `/p/<projectId>/about` — loads about.html

### ZIP upload
1. Zip the same folder into `my-site.zip`
2. Click "Upload file" → select `my-site.zip`
3. Toast: "Unzipping my-site.zip..." → "Deploying 3 files..." → "Deployed! 3 pages are live."
4. New tab opens at `/p/<projectId>`

### Error cases
1. Upload a folder with no HTML files → "No .html file found in the upload. Include at least one HTML file."
2. Upload a folder over 10MB → "Upload exceeds 10MB limit. Remove large files and try again."
3. Upload a corrupted .zip → "That file is not a valid ZIP archive."

### Custom name (single-page)
1. Paste some HTML in the editor
2. Type "akaytech" in the Custom link field
3. The feedback shows: "✓ akaytech is available" (green)
4. Click Deploy
5. The deployed URL is `kayhosthtml.zone.id/akaytech` (not `/site/abc123`)
6. Visit `kayhosthtml.zone.id/akaytech` → loads your page
7. Share the link on WhatsApp → OG preview card shows

### Custom name validation
1. Type "ab" → "Custom name must be at least 3 characters" (red)
2. Type "-akay" → "Custom name can only contain lowercase letters, numbers, and hyphens (no leading/trailing hyphens)"
3. Type "admin" → "admin is a reserved word — try a different name"
4. Type "akay" (if someone else has it) → "akay is already taken — try a different name"

### Edit custom name from My Sites
1. Go to "My Sites"
2. Each site with a custom name shows a purple badge (e.g. `/akaytech`)
3. Click "edit name" on any site
4. Prompt opens — change the name or leave blank to remove it
5. List refreshes with the new name

### Random ID still works (regression check)
1. Paste HTML, leave the Custom link field blank
2. Click Deploy
3. URL is `kayhosthtml.zone.id/site/abc123` (unchanged)

## Architecture decisions

1. **Why `position:absolute;left:-9999px` instead of `display:none` for the folder input?**
   - `display:none` inputs don't respond to `.click()` on some browsers (notably mobile Safari and some older Android browsers). The input must be in the render tree (even if off-screen) for the click event to trigger the file picker.
   - `position:absolute;left:-9999px` moves it off-screen but keeps it renderable. This is the same technique Google Drive, Dropbox, and GitHub use for their hidden file inputs.

2. **Why JSZip via CDN instead of npm?**
   - The project has no build step (it's plain HTML + JS, no bundler). Adding an npm dependency would require setting up a build pipeline.
   - JSZip is a well-established library (10+ years, 30k+ stars) with no known security issues. The CDN URL is from cdnjs which is a reputable CDN.
   - The alternative (server-side unzip) would require a new API route, a new dependency in `package.json`, and would be slower (upload → unzip → store vs. unzip → upload → store).

3. **Why does `handleSiteResolve` fetch `/index.html` for reserved words?**
   - The `/:slug` rewrite in `vercel.json` catches ALL paths matching the slug pattern (3–30 chars, lowercase + hyphens). This includes app routes like `/admin`, `/templates`, `/sites`, etc.
   - For reserved words, the handler needs to serve the SPA so the app's router takes over. Fetching `/index.html` from the same origin is the cleanest way — it returns the static SPA HTML.
   - This adds ~50ms latency for reserved-word paths, which is acceptable.

4. **Why is the custom-name check against BOTH `sites` and `projects` collections?**
   - A custom name should be globally unique across the entire platform. If "akaytech" is taken by a single-page site, it shouldn't be available for a multi-page project (and vice versa).
   - The `checkSlugAvailability` function queries both collections before returning `available: true`.

5. **Why no Pro gating on custom names?**
   - Per the user's instruction: "make it available to ALL users (free tier too)."
   - Custom names are a discovery/branding feature, not a capacity feature. Limiting them to Pro would reduce their value as a user-acquisition tool.

## Known limitations

- **Custom names for multi-page projects** only resolve the index page at `/<custom-name>`. Sub-pages like `/about` are NOT accessible at `/<custom-name>/about` — they're still at `/p/<projectId>/about`. Supporting `/<custom-name>/about` would require a more complex rewrite that catches `/<slug>/*` and conflicts with the SPA catch-all. This can be added in a future phase if needed.
- **No custom-name for multi-page sub-paths.** The `/:slug` rewrite only matches single-segment paths. `/<slug>/<subpath>` would need a separate rewrite.
- **JSZip is loaded on every page** even when the user never uploads a zip. This adds ~90KB to the initial page load. A future optimization could lazy-load JSZip only when a .zip file is selected.
- **The `/:slug` rewrite adds one function invocation** for every custom-name visit. This is the same cost as `/site/:id` visits, so it's not a regression.
