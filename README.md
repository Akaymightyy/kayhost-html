# Kayhost HTML — Paste HTML. Get a link.

Dead-simple HTML hosting. Paste HTML, get a live link in seconds. Multi-provider AI-powered visual editor included.

**Current version: v44** — see `Changelog` section below.

## What's new in v44

1. **Multi-provider AI editor** — the visual HTML editor is no longer Gemini-only. Three additional provider families now appear in the model dropdown:
   - **AshnaAI** (Pro-only) — `lib/ashna.js` + `/api/ashna-models.js`. Per-user 50/day cap tracked in Firestore `ashnaUsage`. Model list is the intersection of an admin allowlist (`ASHNA_ALLOWED_MODELS` env var) and the live Ashna `/models` response, cached 10 min.
   - **OpenCode Zen** (Pro-only) — `lib/ai-providers.js`. Static catalog of 5 models: DeepSeek V4 Flash, MiMo V2.5, Qwen 3.6 Plus, MiniMax M3, Big Pickle. Per-user 50/day cap in Firestore `providerUsage`.
   - **OpenRouter** (Free, not Pro-gated) — dynamic free-model fetching. Hits OpenRouter's live `/models` endpoint, filters for `pricing.prompt === "0" && pricing.completion === "0"`, sorts by context length, caches the top 10 for 30 min. Falls back to 3 hardcoded stable IDs if the live fetch fails. Shares the same browser-id 50/day cap as Gemini (each provider has its own counter).
2. **JSON-parse-first response handling** — all OpenAI-compatible providers (OpenRouter, OpenCode Zen, AshnaAI) now parse the upstream response as JSON FIRST, and only fall back to "is this an HTML error page?" detection when `JSON.parse` genuinely throws. Previously, a successful HTML edit whose content contained `<!doctype html>` or `<html>` would false-positive as a gateway error and block every edit. Applied to `lib/ai-providers.js` and `lib/ashna.js`.
3. **Redesigned click-to-edit AI UX** — replaced the old "click AI button → full panel → type → apply" flow with a floating edit box anchored near the clicked element:
   - Appears automatically when you click any element in the preview iframe (`wireElementClicks` in `index.html`)
   - Shows the element's tag name, DOM breadcrumb, and context-aware quick actions
   - Compact model-selector bar with tier badge (FREE / PRO / BYOK), expandable to a searchable list
   - Stays visible above the mobile keyboard via the `visualViewport` API (repositions on resize)
   - Works in all preview modes (desktop / tablet / phone / fullscreen)
   - "Entire page" button to switch to whole-document editing
4. **Compact anchored model-selector dropdown** — the old full-screen model picker is gone. The floating box has a single-line model bar showing the current model name + tier badge; tapping it expands a searchable list with all available models from all providers. Selected model gets a checkmark.
5. **Responsive preview modes** — Desktop / Tablet / Phone / Fullscreen toggle buttons above the preview iframe. Fullscreen has a floating exit button.
6. **Consolidated API** — the old separate function files (`api/deploy.js`, `api/sites.js`, `api/media.js`, `api/clone.js`, `api/save-user.js`, `api/settings.js`, `api/signin.js`, `api/paystack-verify.js`) have been merged into `api/main.js` (routes via `?route=`) and `api/auth.js` (signin/signup). The frontend URLs (`/api/deploy`, `/api/signin`, etc.) are unchanged — `vercel.json` rewrites them transparently.
7. **Firebase Admin SDK** — `lib/admin-firebase.js` initializes `firebase-admin` for server-side ID token verification (used by the AshnaAI and OpenCode Zen Pro-gating). Requires `FIREBASE_SERVICE_ACCOUNT_KEY` env var (the full JSON key from Firebase Console → Project Settings → Service Accounts → Generate new private key).
8. **Edge Middleware** — `middleware.js` blocks scraper User-Agents (wget, curl, httrack, scrapy, python-requests, etc.) and empty/too-short UAs at the edge before any function runs. Returns 403 immediately. ⚠️ **Note:** the middleware STILL blocks cross-origin referers (section 4 of `middleware.js`). If you need to embed Kayhost in an iframe on another domain, you'll need to remove or relax that block.
9. **Paystack payment verification** — `api/main.js` route `paystack-verify` calls Paystack's verify endpoint to confirm Pro payments. Requires `PAYSTACK_SECRET_KEY` env var.
10. **AI loading UX** — the Apply button now shows a visible status banner (purple "Generating…" → green "OK" → red "!" on error) inside the AI panel. The panel is locked from closing while a request is in flight (`_aiLoading` flag). The floating edit box also shows its own inline loading state.
11. **Free quota raised to 50/day per provider** — Gemini and OpenRouter each get their own independent 50/day counter (previously shared a single 10/day counter). Pro providers (AshnaAI, OpenCode Zen) remain at 50/day per user.
12. **AshnaAI test suite** — `test/ashna.test.js` with stubs for Firebase + Google GenAI, covering model allowlist parsing, display-name generation, and the JSON-parse-first response handler.

---

## Setup

### 1. Install + Firestore rules

```bash
cd kayhost
npm install
```

Firebase Console → Firestore → Rules → paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /sites/{siteId} {
      allow read: if true;
      allow create: if true;
      allow update, delete: if true;
    }
    match /users/{uid} {
      allow read: if true;
      allow create: if true;
      allow update: if true;
    }
    match /admins/{uid} {
      allow read: if request.auth != null;
      allow create: if request.auth != null;
      allow delete: if request.auth != null;
    }
    match /audit/{logId} {
      allow read: if true;
      allow create: if true;
    }
    match /templates/{templateId} {
      allow read: if true;
      allow write: if true;
    }
    match /settings/{key} {
      allow read: if true;
      allow write: if true;
    }
    match /flagged/{flagId} {
      allow read: if true;
      allow write: if true;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

**Important:** These rules apply only to the **client** SDK. The Vercel serverless functions in `/api/` use the Firebase Admin SDK via `lib/admin-firebase.js` (for token verification) and `lib/firebase.js` (for Firestore reads/writes), which bypasses rules — that's how `api/main.js`, `api/admin.js`, and `api/auth.js` can write to `users` / `templates` / `settings` even when no `request.auth` is present.

**Also enable sign-in providers:**
- Firebase Console → Authentication → Sign-in method
- Enable **Email/Password** (for admin login with `kayhost@admin.com`)
- Enable **Google** (add support email)
- Enable **GitHub** (you'll need a GitHub OAuth App — see Firebase docs)

**Create the admin account in Firebase Console:**
- Authentication → Users → Add User
- Email: `kayhost@admin.com`
- Password: `363438`
- This email is hardcoded as admin in `index.html` (`ADMIN_EMAILS` constant) and trusted by `api/admin.js`

**Add your domain to authorized domains:**
- Authentication → Settings → Authorized domains
- Add `kayhosthtml.zone.id` (or whatever your custom domain is)
- Add `your-project.vercel.app` (your Vercel URL)
- Without this, Google/GitHub sign-in will fail with a 400 error on your custom domain

### 2. Cloudinary (for image uploads)

Cloudinary is configured with hardcoded credentials in `api/main.js` (the `media` route):
```js
const CLOUDINARY_CLOUD_NAME = "dbmtqgs3v";
const CLOUDINARY_UPLOAD_PRESET = "kayhost";
```
Replace these with your own if you want image uploads on your own deployment.

### 3. Environment variables (Vercel)

Set these in Vercel → Project → Settings → Environment Variables:

| Var | Required for | Notes |
|---|---|---|
| `GEMINI_API_KEY` | Gemini AI edits | Get from https://aistudio.google.com/apikey (current format starts with `AQ.`) |
| `OPENCODE_API_KEY` | OpenCode Zen models (Pro) | Get from https://opencode.ai |
| `OPENROUTER_API_KEY` | OpenRouter free models | Get from https://openrouter.ai |
| `ASHNA_API_KEY` | AshnaAI models (Pro) | Get from AshnaAI |
| `ASHNA_ALLOWED_MODELS` | AshnaAI model filtering | Comma-separated model IDs the admin has approved |
| `ASHNA_DEFAULT_MODEL` | AshnaAI default (optional) | Must also be in the allowlist |
| `ASHNA_DAILY_LIMIT` | AshnaAI per-user cap (optional) | Default: 50 |
| `PROVIDER_DAILY_LIMIT` | OpenCode Zen per-user cap (optional) | Default: 50 |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Pro-gating (token verification) | Full JSON from Firebase Console → Project Settings → Service Accounts → Generate new private key |
| `PAYSTACK_SECRET_KEY` | Pro payment verification | Get from Paystack dashboard |

### 4. Deploy

```bash
vercel --prod
```

Or: push to GitHub → import to Vercel → done.

---

## What's hardcoded (no env vars)

- `lib/firebase.js` — Firebase client config (public, safe to expose)
- `api/main.js` — Cloudinary cloud name + upload preset
- `api/auth.js` — Firebase API key (public, same as `lib/firebase.js`)

⚠️ Use a **private** GitHub repo if you push the code (so nobody can read your server-side keys).

## How to get your Gemini API key

1. Go to https://aistudio.google.com/apikey
2. Create a key (current format starts with `AQ.`)
3. Set it as the `GEMINI_API_KEY` Vercel env var

`api/ai-edit.js` tries these model names in order: `gemini-flash-latest` → `gemini-2.5-flash` → `gemini-3-flash-preview` → `gemini-3.1-flash-lite`, with a single 503-retry per model, so when Google deprecates one model the fallback kicks in automatically.

---

## Admin access

- **Triple-click the logo** in the top-left of `index.html` → sign-in modal opens
- Sign in with `kayhost@admin.com` / `363438` (or with a Google/GitHub account whose email is in `ADMIN_EMAILS`)
- Admin dashboard has 8 sections:
  1. **Overview** — sites/users counts, 30-day deploy chart
  2. **Users** — list, suspend / unsuspend, Make Pro / Remove Pro, Make admin (deduped by email in v14)
  3. **Sites** — list, delete, view
  4. **Templates** — add (paste OR upload .html file), delete
  5. **Moderation** — flagged sites (placeholder for now)
  6. **Health** — API status, recent errors
  7. **Audit** — last 100 admin actions
  8. **Settings** — feature flags + **Chat Widget** code (Tawk.to / Crisp / Intercom)

## Chat widget (Tawk.to)

1. Go to https://dashboard.tawk.to → sign in
2. Admin → Channels → [your property] → **Code**
3. Copy the entire `<script>...</script>` snippet (with your property ID in the URL)
4. Triple-click the Kayhost logo → sign in as admin → Settings → **Chat Widget (Tawk.to / Crisp / Intercom)**
5. Paste the snippet into the textarea → **Save widget code**
6. Reload the site — the chat widget now loads on every page

To remove: open Settings → Chat Widget → **Clear**.

---

## Pro tier

- **Price:** ₦10,000 / 2 months (covers 30-day TTL + Never-expiry TTL gating + AshnaAI + OpenCode Zen models)
- **How to mark a user Pro:** Admin → Users → find the user → **Make Pro** (or user pays via Paystack — the `paystack-verify` route in `api/main.js` verifies the transaction and sets `pro: true` on the user doc)
- Pro users get:
  - "Never expires" TTL option in the deploy form
  - AshnaAI models in the AI editor (50/day per user)
  - OpenCode Zen models in the AI editor (50/day per user)
- Free users get: Gemini (50/day per browser) + OpenRouter (50/day per browser) + BYOK (unlimited, own key)

---

## Sign-in methods

- **Google** — popup (uses Firebase Auth SDK)
- **GitHub** — popup (uses Firebase Auth SDK)
- **Email / Password** — server-side via `/api/auth?route=signin` which calls the Firebase REST API directly. This bypasses reCAPTCHA + domain restrictions. Error messages are user-friendly ("Connection error. Please try again." / "Invalid email or password." / "Too many attempts. Please wait a few minutes and try again.")

After successful Google/GitHub sign-in, `/api/main?route=save-user` writes the user profile to Firestore `users` collection. It MERGES duplicates by email — if you signed in previously with email/password (different UID), the Google/GitHub sign-in will repoint the doc to the new UID and delete the old one.

---

## AI editor — model tiers

| Tier | Providers | Daily limit | How to unlock |
|---|---|---|---|
| **FREE** | Gemini 2.5 Flash, OpenRouter (dynamic free models) | 50/day each per browser | Just use it — no signup needed |
| **PRO** | AshnaAI, OpenCode Zen (DeepSeek V4 Flash, MiMo V2.5, Qwen 3.6 Plus, MiniMax M3, Big Pickle) | 50/day each per user | Upgrade to Pro (₦10,000 / 2 months) |
| **BYOK** | Gemini Pro, Claude Haiku/Sonnet/Opus, GPT-4.1 mini, GPT-5.5 | Unlimited | Paste your own API key in Settings → AI API Keys (stored in browser only, never sent to server) |

---

## PWA / Service worker

- `sw.js` is a self-destructing service worker — it unregisters itself on fetch. This was added in v7 to clear out the old caching SW that was serving stale content.
- `manifest.json` makes the app installable.

---

## File map

```
kayhost/
├── index.html              # SPA: all views, auth, admin dashboard, AI editor UI
├── middleware.js           # Edge middleware — blocks scraper User-Agents + cross-origin referers
├── vercel.json             # SPA rewrites + /api route consolidation + security headers
├── package.json            # firebase + firebase-admin + @google/genai
├── sw.js                   # Self-destructing service worker (clears old cache)
├── manifest.json           # PWA manifest
├── svarna-template.html    # Starter template
├── README.md               # This file
├── icon.png, icon-192.png, icon-512.png, favicon.png, favicon.ico, apple-touch-icon.png
│
├── api/
│   ├── main.js             # Consolidated dispatcher — deploy/sites/media/clone/save-user/settings/user-profile/paystack-verify/site (via ?route=)
│   ├── auth.js             # Consolidated auth — signin/signup (via ?route=)
│   ├── admin.js            # Admin dashboard GET data + POST actions
│   ├── ai-edit.js          # AI HTML editor — Gemini + OpenRouter (free) + AshnaAI + OpenCode Zen (Pro)
│   ├── ai-providers.js     # PUBLIC endpoint — returns enabled AI providers + dynamic OpenRouter model list
│   ├── ashna-models.js     # PUBLIC endpoint — returns AshnaAI model catalog (Pro)
│   ├── serve.js            # Static asset serving helper
│   └── site/[id].js        # Serve a deployed site by ID (rewritten to /api/main?route=site)
│
├── lib/
│   ├── firebase.js         # Client-side Firebase init (public config)
│   ├── admin-firebase.js   # Server-side Firebase Admin SDK init (requires FIREBASE_SERVICE_ACCOUNT_KEY)
│   ├── ai-providers.js     # Shared config for OpenCode Zen + OpenRouter — model catalogs, dynamic fetching, callProvider()
│   └── ashna.js            # Shared AshnaAI logic — model allowlist, display names, callAshnaChat(), validateAndExtractHtml()
│
└── test/
    ├── ashna.test.js       # Unit tests for lib/ashna.js (allowlist parsing, display names, JSON-parse-first)
    └── stubs/              # Test stubs for firebase-app, firestore, genai
```

---

## Features

- ✅ **Paste & Deploy** — paste HTML → get live URL in seconds
- ✅ **Auto-Expiry** — 1d / 7d / 30d / Never (Never is Pro-only)
- ✅ **Multi-provider AI Visual Editor** — click any element → describe change → AI rewrites HTML. Supports Gemini (free), OpenRouter (free, dynamic model list), AshnaAI (Pro), OpenCode Zen (Pro), and BYOK (Claude / GPT / your own Gemini key)
- ✅ **Click-to-edit floating box** — anchored near the clicked element, works without opening the full AI panel, stays above mobile keyboard, works in all preview modes
- ✅ **Compact model selector** — searchable dropdown with tier badges (FREE / PRO / BYOK) and selected-model checkmark
- ✅ **Responsive preview modes** — Desktop / Tablet / Phone / Fullscreen
- ✅ **Loading state UX** — visible status banner during AI generation (purple → green → red), panel locks during requests
- ✅ **Dashboard** — list your pages with expiry countdown
- ✅ **Image Uploads** — via Cloudinary
- ✅ **Multi-file site upload** — drag a folder → Kayhost merges into one HTML
- ✅ **Clone from URL** — paste any URL → fetch → editable copy (SSRF-protected)
- ✅ **Sign in** — Google, GitHub, or email/password
- ✅ **Admin dashboard** — 8 sections including chat-widget config
- ✅ **Chat widget** — admin-configurable, supports Tawk.to / Crisp / Intercom / any
- ✅ **Template management** — paste OR upload .html file
- ✅ **Paystack payments** — Pro upgrade via Paystack (verified server-side)
- ✅ **Edge middleware** — blocks scraper bots before any function runs
- ✅ **Theme toggle** — light / dark
- ✅ **PWA installable**

---

## Changelog

- **v44** (this release) — Multi-provider AI editor (AshnaAI, OpenCode Zen, OpenRouter); JSON-parse-first response handling; redesigned click-to-edit floating box; compact searchable model selector with tier badges; responsive preview modes (desktop/tablet/phone/fullscreen); consolidated API into `api/main.js` + `api/auth.js`; Firebase Admin SDK for Pro-gating; Paystack payment verification; edge middleware for scraper blocking; AI loading UX (status banner + panel lock); free quota raised to 50/day per provider; AshnaAI test suite.
- **v15** — Preview iframe sandbox fix (`allow-scripts`); public Templates view fetches admin-saved templates; AI editor model list fixed (`gemini-flash-latest` / `2.5-flash` / `2.0-flash`); 45s client-side AI timeout; clone URL 8s timeout + actual error messages; chat-widget console logging.
- **v14** — Chat widget admin config; HTML file upload in Templates; duplicate users deep fix (merge by email in save-user.js + dedupe on display).
- **v13** — Patch release for `signin.js` (clean error messages).
- **v12** — Firestore rules rewrite to allow server-side writes to `users` / `templates` / `settings` (no `request.auth` on server).
- **v11** — Gemini SDK switch to `@google/genai`; deprecated model fallback list + 503 retry.
- **v10** — Removed duplicate `escapeHtml` (real fix for sign-in modal disappearing in ESM strict mode).
- **v9** — Gemini model fallback, Clone SSRF protection, brand polish.
- **v8** — Google + GitHub sign-in, admin dashboard (7 sections), template management, suspend/pro controls.
- **v5–v7** — Self-destructing service worker (caching SW was serving stale content), admin API body fix.
- **v1–v4** — Initial release: paste HTML, deploy, get link, AI editor, Cloudinary. Critical `</script>` inside JS string bug fixed.
