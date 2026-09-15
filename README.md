# Kayhost HTML — Instant HTML hosting + AI editor

Paste HTML, get a live link in seconds. Click any element to edit with AI.

## What's in the zip

```
kayhost/
├── index.html              ← Single-file SPA (frontend)
├── vercel.json             ← Rewrites: /site/{id} → /api/site/[id]
├── package.json            ← Dependencies: firebase, @google/generative-ai
├── README.md               ← This file
└── api/
    ├── _firebase.js         ← Firebase init (config hardcoded)
    ├── deploy.js            ← POST /api/deploy → saves HTML, returns URL
    ├── sites.js             ← GET /api/sites → lists sites by browser
    ├── ai-edit.js           ← POST /api/ai-edit → Gemini rewrites HTML
    ├── media.js             ← POST /api/media → uploads images to Storage
    └── site/[id].js        ← GET /site/{id} → serves raw HTML
```

## Setup (3 steps — no env vars needed)

### 1. Install dependencies
```bash
cd kayhost
npm install
```

### 2. Firestore rules
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
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### 3. Deploy
```bash
vercel --prod
```

Or: push to GitHub → import to Vercel → deploy. Done.

---

## Everything is hardcoded — no env vars

The Firebase config and Gemini API key are **hardcoded directly in the API files**:

- `api/_firebase.js` — Firebase config (the same one you gave me)
- `api/ai-edit.js` — Gemini API key (hardcoded)
- `api/media.js` — Firebase Storage config (hardcoded)

**Why this is safe:** Vercel serverless functions run on Vercel's servers. The browser never sees this code — only the HTTP response. So your API key stays private.

**⚠️ IMPORTANT:** If you push to a **public GitHub repo**, anyone can read the credentials. Either:
- Use a **private** repo (recommended)
- Or if you must use a public repo, replace the hardcoded values with environment variables before pushing

---

## How to change the Gemini API key

If the default key doesn't work (or you want your own):
1. Go to https://aistudio.google.com/apikey
2. Create a key (starts with `AIza...`)
3. Open `api/ai-edit.js`
4. Replace `"Kayhost_API_Key"` with your key
5. Re-deploy

## Features

1. **Paste & Deploy** — paste HTML → get live URL in seconds
2. **Auto-Expiry** — 1 day / 7 days / 30 days / never
3. **AI Visual Editor** — click any element → describe change in English → Gemini rewrites HTML
4. **Dashboard** — list all your pages with expiry countdown
5. **Media Uploads** — upload images to Firebase Storage

## Tech notes

- **Frontend:** Single `index.html` — vanilla JS, no frameworks
- **Backend:** Vercel serverless functions in `/api`
- **Database:** Firebase Firestore — `sites` collection
- **AI:** Google Gemini 1.5 Flash (server-side only)
- **Storage:** Firebase Storage (for image uploads)
- **No env vars needed** — everything hardcoded in server-side files
