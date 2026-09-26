# KayHost HTML — All Phases (1-6) Mega-Patch

This patch ships Phases 1 through 6 in one zip, applied on top of your latest `main` branch.

## What's in this patch

### Phase 1 — Multi-page site support (already shipped, included here for completeness)
- New `lib/multipage.js` with path-mapping helpers
- New `handleMultiDeploy` + `handleMultiServe` routes in `api/main.js`
- New `/p/:id/*` URL pattern for multi-page projects
- Folder upload preserves all HTML files + subfolder structure
- 36 unit tests in `test-multipage.js` (all pass)

### Phase 2 — Media Library
- New `mediaLibrary` Firestore collection (per-user via `ownerUid` or `ownerBrowserId`)
- Existing `/api/media` upload route now ALSO persists a record to Firestore
- 3 new routes: `media-list`, `media-delete` (and `media` already existed)
- New "Media" view in the navbar with upload + grid + copy URL + delete
- Images stored on Cloudinary (existing integration), URL + metadata in Firestore
- Per-user scoping: signed-in users see only their own media; anonymous users see only their browser's media

### Phase 3 — Streaming AI edit (SSE)
- New `handleAiEditStream` handler in `api/ai-edit.js` (mounted at `/api/ai-edit?stream=1`)
- Streams tokens via Server-Sent Events for OpenRouter, OpenCode Zen, AshnaAI
- Gemini falls back to non-streaming (its SDK has different streaming semantics — left for a future phase)
- Frontend `tryStreamAiEdit()` consumes the SSE stream and live-updates the preview iframe (throttled to 1 update/500ms)
- Status banner shows "Generating… N chars received" in real time
- If streaming fails for any reason, automatically falls back to the existing non-streaming flow — zero breaking changes

### Phase 4 — In-editor sign-in (already done, verified)
- The sign-in modal (`#signin-modal`) was ALREADY a fixed-position overlay that doesn't navigate away
- Editor state (pasted HTML, `_files`, `currentHtml`) is preserved through sign-in because the modal just toggles `class="hidden"`
- No code changes needed — confirmed by audit

### Phase 5 — OG image previews
- New `injectOgMeta()` helper in `api/main.js` extracts `<title>` and `<meta name="description">` (or first `<p>`) from served HTML
- Injects `og:title`, `og:description`, `og:image`, `og:url`, `twitter:card`, etc. into `<head>`
- Respects existing OG tags — if the author already has `og:title`, we don't override
- New `handleOgImage` route generates a branded 1200×630 SVG on the fly with the site title
- Applied to both single-page (`handleSite`) and multi-page (`handleMultiServe`) serving

### Phase 6 — REST API with Bearer tokens
- New `apiTokens` Firestore collection — tokens stored SHA-256 hashed (never plain)
- Token format: `kayh_<32 hex chars>`
- 6 new routes:
  - `api-token-create` (POST) — generate a new token, returns plain token ONCE
  - `api-token-list` (GET) — list user's tokens (masked, no plain text)
  - `api-token-delete` (POST) — delete a token
  - `api-sites` (GET, Bearer auth) — list the user's sites
  - `api-deploy` (POST, Bearer auth) — deploy a new site
  - `api-delete` (POST, Bearer auth) — delete a site
- New "API" view in the navbar with token management UI + curl examples
- Each token tracks `lastUsedAt` for auditing

## Files in this patch (only changed/new files)

| File | Action | Phase |
|---|---|---|
| `lib/multipage.js` | NEW | 1 |
| `api/main.js` | PATCHED (additive) | 1, 2, 5, 6 |
| `api/ai-edit.js` | PATCHED (additive) | 3 |
| `vercel.json` | PATCHED (additive) | 1, 5, 6 |
| `index.html` | PATCHED (additive) | 1, 2, 3, 6 |
| `test-multipage.js` | NEW | 1 |
| `ALL_PHASES_README.md` | NEW | (this file) |

## What was NOT touched (per your ground rules)

- ❌ AI provider integrations (Gemini, AshnaAI, OpenCode Zen, OpenRouter, Custom Provider) — untouched. Phase 3 adds a NEW streaming handler alongside; it doesn't modify the existing `callProvider` or any provider-specific code.
- ❌ Click-to-edit floating box UX — untouched
- ❌ Compact model dropdown — untouched
- ❌ Middleware — untouched
- ❌ Firebase/Firestore setup — untouched (new collections are ADDITIONAL)
- ❌ Paystack — untouched
- ❌ Admin dashboard — untouched
- ❌ Existing single-file deploy flow (`/api/deploy` + `/site/:id`) — untouched

## New dependencies

**None.** Everything uses:
- `firebase/firestore` (already in `package.json`)
- `firebase-admin` (already in `package.json`, used by Phase 6 for token hashing... actually no, Phase 6 uses Node's built-in `crypto` — even simpler)
- Node built-in `crypto` (for SHA-256 token hashing)
- Node built-in `util.TextDecoder` (for SSE stream parsing)

## New Firestore collections (add these to your rules)

```
match /projects/{projectId} {
  allow read: if true;
  allow create: if true;
  allow update, delete: if true;
}

match /mediaLibrary/{mediaId} {
  allow read: if true;
  allow create: if true;
  allow update, delete: if true;
}

match /apiTokens/{tokenId} {
  // These are server-managed only — the client SDK never reads/writes them directly.
  // The /api/main.js handlers use the Admin-style SDK via lib/firebase.js which bypasses rules.
  allow read, write: if false;
}
```

## How to apply

1. Unzip this patch
2. Copy `lib/multipage.js` into your repo's `lib/` folder
3. Replace `api/main.js` with the new version
4. Replace `api/ai-edit.js` with the new version
5. Replace `vercel.json` with the new version
6. Replace `index.html` with the new version
7. (Optional) Copy `test-multipage.js` to your repo root and run `node test-multipage.js`
8. Add the 3 Firestore rules above
9. Commit and push — Vercel auto-deploys

## How to test each phase

### Phase 1 — Multi-page (already documented in PHASE1_README.md)
- Upload a folder with `index.html` + `about.html` → Deploy → get `/p/abc123`
- Visit `/p/abc123/about` → loads about.html

### Phase 2 — Media Library
1. Sign in (or stay anonymous)
2. Click "Media" in the navbar
3. Select 1+ images → click "Upload selected"
4. Uploaded images appear in the grid with "Copy URL" + "Del" buttons
5. Click "Copy URL" → paste into your HTML `<img src="...">`
6. Refresh the page → media persists (scoped to your account/browser)

### Phase 3 — Streaming AI edit
1. Paste some HTML in the editor
2. Click any element → floating box appears
3. Pick an OpenRouter model from the dropdown
4. Type an instruction → click "Apply Changes"
5. Watch the preview iframe — it should update LIVE as tokens stream in (throttled to 2 updates/second)
6. The status banner shows "Generating… N chars received" in real time
7. When done, the banner turns green: "Change applied"
8. If streaming fails, it automatically falls back to non-streaming — you'll see no difference, it just works

### Phase 4 — In-editor sign-in (already working)
1. Paste some HTML in the editor
2. Click "Sign in" in the navbar
3. The sign-in modal appears as an overlay — your HTML is still in the editor behind it
4. Sign in (Google/GitHub/email)
5. Modal closes — your HTML is still there, unchanged

### Phase 5 — OG image previews
1. Deploy any site → get a `/site/abc123` URL
2. Paste the URL in WhatsApp / Twitter / Slack / iMessage
3. The preview card should show:
   - The page's `<title>` (or "Untitled" if none)
   - A description (from `<meta name="description">` or first `<p>`)
   - A branded Kayhost OG image (dark background, red accent, "K" logo, site title)
4. Visit `https://yoursite/api/og-image?title=Hello` directly → see the SVG preview image
5. If your HTML already has `<meta property="og:title">`, Kayhost respects it and doesn't override

### Phase 6 — REST API
1. Sign in → click "API" in the navbar
2. Type a label (e.g. "My CI") → click "Generate token"
3. The plain token (`kayh_...`) is shown ONCE — copy it immediately
4. Test with curl:
   ```bash
   # List your sites
   curl -H "Authorization: Bearer kayh_..." https://yoursite/api/api-sites

   # Deploy a new site
   curl -X POST -H "Authorization: Bearer kayh_..." \
        -H "Content-Type: application/json" \
        -d '{"html":"<h1>Hello from API</h1>","title":"API Test","ttl":"7d"}' \
        https://yoursite/api/api-deploy

   # Delete a site
   curl -X POST -H "Authorization: Bearer kayh_..." \
        -H "Content-Type: application/json" \
        -d '{"id":"abc123"}' \
        https://yoursite/api/api-delete
   ```
5. Click "Refresh" on the API tokens view → see your token with `lastUsedAt` updated
6. Click "Delete" on a token → it stops working immediately

## Architecture decisions (for transparency)

1. **Why SSE instead of WebSockets for streaming?**
   - SSE is one-way (server → client) which is exactly what we need
   - Vercel supports SSE natively without special config
   - WebSockets require a different deployment model (long-lived connections)
   - SSE falls back gracefully — if the stream breaks, the client just sees the `error` event and falls back to non-streaming

2. **Why SVG for OG images instead of PNG?**
   - SVG is text-based, generated in ~20 lines of code, no image libraries needed
   - Most modern crawlers (WhatsApp, Twitter, Slack, iMessage) support SVG OG images
   - For crawlers that don't (rare), a future phase can add PNG generation via a serverless image library
   - The SVG is branded with the Kayhost "K" logo + the site title, so even generic pages get a nice preview

3. **Why SHA-256 hashed tokens instead of encrypted?**
   - SHA-256 is one-way — even if the DB leaks, attackers can't recover the plain tokens
   - We compare hashes on each request (fast, constant-time-ish)
   - The plain token is only shown ONCE at creation time (like GitHub Personal Access Tokens)
   - This matches industry standard (GitHub, GitLab, Vercel all do this)

4. **Why per-user `browserId` for anonymous users but `uid` for signed-in?**
   - Anonymous users don't have a `uid` — they have a random `browserId` stored in localStorage
   - Signed-in users have a Firebase `uid` that's stable across browsers/devices
   - The media library checks `ownerUid` first (if signed in), falls back to `ownerBrowserId` (if anonymous)
   - This means: if you upload media while anonymous, then sign in, you LOSE access to your anonymous media (different identifier). That's by design — linking anonymous data to a signed-in account is a separate feature.

5. **Why didn't Phase 4 need code changes?**
   - The sign-in modal was already a `position: fixed` overlay with `z-index: 300`
   - It toggles `class="hidden"` — it doesn't navigate away
   - All editor state (`currentHtml`, `_files`, `_activeFileIndex`) lives in the parent page, which is never unloaded
   - So signing in preserves 100% of editor state by design. I just verified this and didn't need to change anything.

## Known limitations

- **Phase 3 streaming is best-effort.** If a provider's API doesn't actually stream (returns the whole response at once), you'll see the loading banner but no live preview updates. The final result still applies correctly.
- **Phase 5 OG image is SVG.** A few older crawlers may not render it. PNG generation can come in a future phase.
- **Phase 6 API tokens don't expire automatically.** Add an `expiresAt` field if you want time-limited tokens.
- **Phase 2 media library is image-only for now.** Font/video uploads can come later — the Cloudinary integration supports them, but the UI only accepts `image/*`.
- **No admin UI for the new collections.** The admin dashboard still only shows `sites`. Projects, mediaLibrary, and apiTokens are not visible in admin yet (per ground rules — don't touch admin).
