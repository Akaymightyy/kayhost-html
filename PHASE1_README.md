# KayHost HTML — Phase 1: Multi-page site support

This patch adds proper multi-page routing. 100% additive — the existing single-file paste/deploy flow is untouched.

## What it does

When a user uploads a folder (or builds a project with 2+ HTML files in the editor tabs), Kayhost now deploys it as a multi-page project:

- `index.html` → `/`
- `about.html` → `/about`
- `contact.html` → `/contact`
- `blog/post-1.html` → `/blog/post-1`
- `css/style.css` → `/css/style.css` (non-HTML keeps its extension)
- `js/main.js` → `/js/main.js`

Folder structure is preserved for nested pages. Single-file paste deploy keeps working exactly as before — multi-page only kicks in when there are 2+ HTML files.

## Files in this patch

| File | Action | Purpose |
|---|---|---|
| `lib/multipage.js` | NEW | Shared helpers: `filePathToUrlPath`, `buildPathMap`, `resolvePath`, `validateFiles`, `getMimeType`, `isMultiPageProject` |
| `api/main.js` | PATCHED (additive) | Adds `handleMultiDeploy` + `handleMultiServe` handlers + 2 new cases in the dispatcher switch. Existing handlers untouched. |
| `vercel.json` | PATCHED (additive) | Adds 4 new rewrites: `/api/multi-deploy`, `/p/:id`, `/p/:id/`, `/p/:id/:path*`. Also adds `p` to the SPA catch-all exclusion so `/p/...` doesn't get intercepted by index.html. |
| `index.html` | PATCHED (additive) | Deploy button now detects 2+ HTML files and routes to `/api/multi-deploy` instead of `/api/deploy`. Folder upload now preserves all HTML files (not just the first) and preserves subfolder structure via `webkitRelativePath`. |
| `test-multipage.js` | NEW | 36 unit tests for `lib/multipage.js` — all pass. Run with `node test-multipage.js`. |

## What was NOT touched (per your ground rules)

- ❌ AI provider integrations (Gemini, AshnaAI, OpenCode Zen, OpenRouter, Custom Provider) — untouched
- ❌ Click-to-edit floating box UX — untouched
- ❌ Compact model dropdown — untouched
- ❌ Middleware fix — untouched
- ❌ Firebase/Firestore setup — untouched (new `projects` collection is ADDITIONAL, existing `sites` collection unchanged)
- ❌ Paystack — untouched
- ❌ Admin dashboard — untouched
- ❌ Existing single-file deploy flow (`/api/deploy` + `/site/:id`) — untouched, still works identically

## New dependencies

**None.** This patch uses only `firebase/firestore` (already in `package.json`) and Node built-ins.

## New Firestore collection

A new `projects` collection is added. Each doc:

```js
{
  id: "abc123",
  title: "My Site",
  browserId: "user-xyz",
  createdAt: 1695000000000,
  expiresAt: 1695000864000000,  // or null for "Never" (Pro-only)
  files: {
    "index.html": "<!DOCTYPE html>...",
    "about.html": "<!DOCTYPE html>...",
    "blog/post-1.html": "<!DOCTYPE html>...",
    "css/style.css": "body { ... }",
    "js/main.js": "console.log('hi');"
  },
  pathMap: {
    "/": "index.html",
    "/about": "about.html",
    "/blog/post-1": "blog/post-1.html",
    "/css/style.css": "css/style.css",
    "/js/main.js": "js/main.js"
  }
}
```

Add this to your Firestore rules (alongside the existing `sites` rule):

```
match /projects/{projectId} {
  allow read: if true;
  allow create: if true;
  allow update, delete: if true;
}
```

## How to apply

1. Unzip this patch
2. Copy `lib/multipage.js` into your repo's `lib/` folder
3. Replace `api/main.js` with the new version
4. Replace `vercel.json` with the new version
5. Replace `index.html` with the new version
6. (Optional) Copy `test-multipage.js` to your repo root and run `node test-multipage.js` to verify the path-mapping logic
7. Add the `projects` Firestore rule above
8. Commit and push — Vercel auto-deploys

## How to test after deploying

### Test 1: Single-file still works (regression check)
1. Paste a single HTML file in the editor
2. Click Deploy
3. You should get a `/site/abc123` URL (same as before)
4. Open it — page loads normally

### Test 2: Multi-page via folder upload
1. Create a local folder with:
   ```
   my-site/
     index.html      (with a link to <a href="/about">About</a>)
     about.html
     contact.html
     css/style.css
   ```
2. Click "Upload folder" → select the folder
3. The editor should show 4 tabs (index.html, about.html, contact.html, style.css)
4. Click Deploy
5. You should get a `/p/abc123` URL (NOT `/site/...`)
6. Open it → index.html loads
7. Click the "About" link → `/p/abc123/about` loads about.html
8. Visit `/p/abc123/contact` directly → contact.html loads
9. Visit `/p/abc123/css/style.css` → the CSS file is served with `text/css` content-type

### Test 3: Nested folder structure
1. Upload a folder with `blog/post-1.html` and `blog/post-2.html`
2. Deploy
3. Visit `/p/abc123/blog/post-1` and `/p/abc123/blog/post-2` — both should load

### Test 4: 404 handling
1. Visit `/p/abc123/nonexistent` → should show "The page '/nonexistent' doesn't exist in this project."

### Test 5: Run the unit tests locally
```bash
node test-multipage.js
```
Should print `=== 36 passed, 0 failed ===`

## Phase 1 design decisions (for transparency)

1. **Why a separate `/p/:id/*` URL instead of reusing `/site/:id`?**
   - `/site/:id` serves a single HTML blob. Multi-page needs path resolution. Mixing them would require sniffing the doc to decide which handler runs — fragile.
   - Separate URL makes it clear which kind of site it is and lets each handler stay simple.

2. **Why a separate `projects` collection instead of extending `sites`?**
   - `sites` docs have a single `html` field. Adding a `files` object + `pathMap` to every site would bloat the collection and break the existing `handleSite` handler.
   - New collection = zero risk to existing sites.

3. **Why is the single-file deploy path completely unchanged?**
   - Per your ground rule: "100% ADDITIVE. Do not touch existing working code."
   - The deploy button checks `hasMultipleHtml` — if false, it runs the EXACT same code as before, character-for-character.

4. **Why does the folder upload now keep all HTML files instead of just the first?**
   - Previously the folder handler only kept the first HTML file and inlined CSS/JS into it. That made multi-page impossible.
   - Now it keeps every HTML file as its own tab, preserving subfolder structure via `webkitRelativePath`. The top-level uploaded-folder name is stripped (e.g. `my-site/index.html` → `index.html`) but subfolders are preserved (e.g. `my-site/blog/post.html` → `blog/post.html`).

5. **What about binary assets (images, fonts)?**
   - Firestore docs are limited to 1MB per field. Storing base64 images in the `files` map would blow that limit fast.
   - Phase 1 keeps the existing pattern: images are uploaded to Cloudinary via `/api/media` and referenced by URL in the HTML. The `files` map only stores text (HTML/CSS/JS).
   - Phase 2 (Media Library) will formalize this with a proper per-user media library.

6. **What about the `api/serve.js` file that was already in the repo?**
   - It existed but was never wired into `vercel.json` and never called by the frontend. I left it untouched (per ground rules — no cleanup).
   - My new `handleMultiServe` in `api/main.js` does the same job but is properly wired. You can delete `api/serve.js` later if you want, but I didn't touch it.

## Known limitations (not bugs, by design for Phase 1)

- No SPA-style client-side routing fallback. If a project's HTML uses `<a href="/about">` and the user clicks it, the browser does a full page load to `/p/abc123/about` — which is correct. But if the HTML uses client-side routing (React Router, etc.), the server will 404 on unknown paths. That's expected — Phase 1 is for static multi-page sites.
- No ZIP upload yet (the existing "ZIP upload coming soon" toast is still there). Phase 1 covers folder upload + manual tab creation. ZIP can come in a later phase if you want.
- The `projects` collection is NOT visible in the admin dashboard yet (per ground rules — don't touch admin). Admin still only sees `sites`. Adding a projects tab to admin can come later.
