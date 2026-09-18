# Kayhost HTML — Paste HTML. Get a link.

Dead-simple HTML hosting. Paste HTML, get a live link in seconds. AI-powered visual editor included.

**Current version: v14** — see `Changelog` section below.

## What's new in v14

1. **Tawk.to / chat-widget integration** — admin can paste the full embed code (Tawk.to, Crisp, Intercom, anything) into **Admin → Settings → Chat Widget**. Stored in Firestore `settings/chatWidget`. The frontend auto-injects it on every page load via the new public `/api/settings` endpoint. Update from the dashboard anytime — no redeploy.
2. **HTML file upload in admin Templates** — Admin → Templates → "Add template" now has an "Upload .html file" button (FileReader-based). Reads the file, fills the textarea, auto-fills the name from the filename. 5MB cap. Paste still works as fallback.
3. **Duplicate users — deep fix** — root cause found and patched. `save-user.js` (Google/GitHub path) used to only check for an existing doc by UID; now it ALSO checks by email and MERGES duplicates into one canonical doc (deletes the rest, unions `pro` / `suspended` flags). The admin Users tab also dedupes existing legacy duplicates on display, with a "N merged" badge. Suspend / Make Pro / Make Admin actions now apply to all merged UIDs at once.

---

## Setup (3 steps — no env vars)

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

**Important:** These rules apply only to the **client** SDK. The Vercel serverless functions in `/api/` use the Firebase Admin-style SDK via `api/_firebase.js`, which bypasses rules — that's how `save-user.js`, `admin.js`, and `settings.js` can write to `users` / `templates` / `settings` even when no `request.auth` is present.

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

1. Go to https://cloudinary.com → sign up (free tier = 25 credits/month)
2. Dashboard → copy your **Cloud Name**
3. Settings → Upload → enable **unsigned uploads** → create an upload preset
4. Open `api/media.js` → replace the two placeholders:
   ```js
   const CLOUDINARY_CLOUD_NAME = "your-cloud-name";
   const CLOUDINARY_UPLOAD_PRESET = "your-upload-preset";
   ```

### 3. Deploy

```bash
vercel --prod
```

Or: push to GitHub → import to Vercel → done.

---

## What's hardcoded (no env vars)

- `api/_firebase.js` — Firebase config (uses the client SDK initialized server-side)
- `api/ai-edit.js` — Gemini API key
- `api/media.js` — Cloudinary cloud name + upload preset

⚠️ Use a **private** GitHub repo if you push the code (so nobody can read your keys).

## How to get your Gemini API key

1. Go to https://aistudio.google.com/apikey
2. Create a key (current format starts with `AQ.`)
3. Open `api/ai-edit.js` → replace the `GEMINI_API_KEY` constant

`ai-edit.js` tries four model names in order (`gemini-3.6-flash` → `gemini-2.5-flash` → `gemini-1.5-flash` → `gemini-flash-latest`) with a single 503-retry, so when Google deprecates one model the fallback kicks in automatically.

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

- **Price:** ₦10,000 / 2 months (covers 30-day TTL + Never-expiry TTL gating)
- **How to mark a user Pro:** Admin → Users → find the user → **Make Pro**
- Pro users get access to the "Never expires" TTL option in the deploy form
- Free users are limited to 1-day / 7-day / 30-day TTLs

---

## Sign-in methods

- **Google** — popup (uses Firebase Auth SDK)
- **GitHub** — popup (uses Firebase Auth SDK)
- **Email / Password** — server-side via `/api/signin.js` which calls the Firebase REST API directly. This bypasses reCAPTCHA + domain restrictions. Error messages are user-friendly ("Connection error. Please try again." / "Invalid email or password." / "Too many attempts. Please wait a few minutes and try again.")

After successful Google/GitHub sign-in, `/api/save-user.js` writes the user profile to Firestore `users` collection. In v14 it now MERGES duplicates by email — if you signed in previously with email/password (different UID), the Google/GitHub sign-in will repoint the doc to the new UID and delete the old one.

---

## PWA / Service worker

- `sw.js` is a self-destructing service worker — it unregisters itself on fetch. This was added in v7 to clear out the old caching SW that was serving stale content.
- `manifest.json` makes the app installable.

---

## File map

```
kayhost/
├── index.html              # SPA: all views, auth, admin dashboard
├── vercel.json             # SPA rewrites + /api routes
├── package.json            # firebase + @google/genai
├── sw.js                   # Self-destructing service worker (clears old cache)
├── manifest.json           # PWA manifest
├── README.md               # This file
├── icon.png, icon-192.png, icon-512.png, favicon.png, favicon.ico, apple-touch-icon.png
└── api/
    ├── _firebase.js        # Server-side Firebase init
    ├── admin.js            # Admin dashboard GET data + POST actions
    ├── ai-edit.js          # Gemini-powered HTML editor
    ├── clone.js            # Clone-from-URL (SSRF-protected)
    ├── deploy.js           # Save HTML, return shareable link
    ├── media.js            # Cloudinary image upload proxy
    ├── save-user.js        # Google/GitHub user profile save (dedupe by email)
    ├── signin.js           # Email/password via Firebase REST API (bypasses reCAPTCHA)
    ├── sites.js             # List sites for a browser ID
    ├── settings.js         # PUBLIC endpoint — returns chatWidget embed code
    └── site/[id].js        # Serve a deployed site by ID
```

---

## Features

- ✅ **Paste & Deploy** — paste HTML → get live URL in seconds
- ✅ **Auto-Expiry** — 1d / 7d / 30d / Never (Never is Pro-only)
- ✅ **AI Visual Editor** — click any element → describe change → Gemini rewrites HTML
- ✅ **Dashboard** — list your pages with expiry countdown
- ✅ **Image Uploads** — via Cloudinary
- ✅ **Multi-file site upload** — drag a folder → Kayhost merges into one HTML
- ✅ **Clone from URL** — paste any URL → fetch → editable copy (SSRF-protected)
- ✅ **Sign in** — Google, GitHub, or email/password
- ✅ **Admin dashboard** — 8 sections including chat-widget config
- ✅ **Chat widget** — admin-configurable, supports Tawk.to / Crisp / Intercom / any
- ✅ **Template management** — paste OR upload .html file (v14)
- ✅ **Theme toggle** — light / dark
- ✅ **PWA installable**

---

## Changelog

- **v14** (this release) — Chat widget admin config; HTML file upload in Templates; duplicate users deep fix (merge by email in save-user.js + dedupe on display).
- **v13** — Patch release for `signin.js` (clean error messages).
- **v12** — Firestore rules rewrite to allow server-side writes to `users` / `templates` / `settings` (no `request.auth` on server).
- **v11** — Gemini SDK switch to `@google/genai`; deprecated model fallback list + 503 retry.
- **v10** — Removed duplicate `escapeHtml` (real fix for sign-in modal disappearing in ESM strict mode).
- **v9** — Gemini model fallback, Clone SSRF protection, brand polish.
- **v8** — Google + GitHub sign-in, admin dashboard (7 sections), template management, suspend/pro controls.
- **v5–v7** — Self-destructing service worker (caching SW was serving stale content), admin API body fix.
- **v1–v4** — Initial release: paste HTML, deploy, get link, AI editor, Cloudinary. Critical `</script>` inside JS string bug fixed.
