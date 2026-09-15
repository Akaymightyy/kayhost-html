# Kayhost HTML — Instant HTML hosting + AI editor

Paste HTML, get a live link in seconds. Click any element to edit with AI.

## Folder structure

```
kayhost/
├── index.html              ← Single-file SPA (frontend)
├── vercel.json             ← Rewrites: /site/{id} → /api/site/[id], everything else → /index.html
├── package.json            ← Dependencies: firebase-admin, @google/generative-ai
├── README.md               ← This file
└── api/
    ├── _firebase.js         ← Shared Firebase Admin init (reads env vars)
    ├── deploy.js            ← POST /api/deploy → saves HTML to Firestore, returns { id, url }
    ├── sites.js             ← GET /api/sites?browserId=xxx → lists sites by browser
    ├── ai-edit.js           ← POST /api/ai-edit → calls Gemini, returns rewritten HTML
    ├── media.js             ← POST /api/media → uploads image to Firebase Storage
    └── site/
        └── [id].js         ← GET /site/{id} → serves raw HTML from Firestore (with expiry check)
```

## Setup (5 steps)

### 1. Install dependencies
```bash
cd kayhost
npm install
```

### 2. Firebase setup
1. Go to [Firebase Console](https://console.firebase.google.com) → your project (`akaymightyy`)
2. **Firestore Database** → Create database (production mode)
3. **Service Account**: Project Settings → Service Accounts → Generate new private key → download the JSON
4. **Storage** → Enable it (for image uploads)

### 3. Set environment variables in Vercel
In your Vercel project → Settings → Environment Variables, add:

**Firebase (one of two options):**

Option A (recommended — one variable):
```
FIREBASE_SERVICE_ACCOUNT_JSON = { ...the full JSON key you downloaded... }
```

Option B (split):
```
FIREBASE_PROJECT_ID = akaymightyy
FIREBASE_CLIENT_EMAIL = firebase-adminsdk-xxx@akaymightyy.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY = -----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n
FIREBASE_STORAGE_BUCKET = akaymightyy.appspot.com
```

**Gemini AI:**
```
GEMINI_API_KEY = Kayhost_API_Key
```

**Base URL (optional):**
```
KAYHOST_BASE_URL = https://kayhost-html.vercel.app
```

### 4. Firestore rules
Paste these rules (Firebase Console → Firestore → Rules):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Anyone can create a site (anonymous usage)
    // Anyone can read a site (public links)
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

### 5. Deploy
```bash
vercel --prod
```

Or push to GitHub → import to Vercel.

## Features

### 1. Paste & Deploy
- Paste raw HTML in the textarea
- Pick expiry: 1 day / 7 days / 30 days / never
- Click "Deploy" → get a live URL like `https://kayhost-html.vercel.app/site/abc123`
- "Copy Link" button for instant sharing

### 2. Auto-Expiry (TTL)
- Each site has `expiresAt` in Firestore
- The `/site/{id}` route checks: if expired → shows a friendly "This link has expired" page
- "Never" = no expiry

### 3. AI Visual Editor
- Click "✨ AI edit mode" on the preview
- Click any element in the live preview
- Describe what you want to change in plain English (e.g. "make the heading red and bigger")
- The app sends `{ html, selector, instruction }` to `/api/ai-edit`
- Gemini rewrites the HTML and the preview updates live
- Click "Deploy" to save the new version

### 4. Dashboard
- Click "My Pages" in the topbar
- Lists all sites created from this browser (stored by a random browser ID in localStorage)
- Each row shows: title, expiry countdown, open link, copy link, delete

### 5. Media Uploads
- Upload tab → drop an image file
- The image uploads to Firebase Storage via `/api/media`
- Returns a public URL you can paste into your HTML (`<img src="...">`)

## Tech notes

- **Frontend**: Single `index.html` — vanilla JS, no frameworks, no build step
- **Backend**: Vercel serverless functions in `/api`
- **Database**: Firebase Firestore — `sites` collection, each doc: `{ id, html, title, browserId, createdAt, expiresAt }`
- **AI**: Google Gemini 1.5 Flash — called server-side only, API key never exposed to browser
- **Storage**: Firebase Storage for image uploads
- **Routing**: `vercel.json` rewrites — `/site/{id}` → server function that serves raw HTML, everything else → `index.html` (SPA)

## How the AI editor works

1. User clicks an element in the iframe preview
2. A script injected into the iframe generates a CSS selector for that element
3. The selector is sent to the parent window via `postMessage`
4. User types a change instruction ("make the button bigger")
5. The app calls `/api/ai-edit` with `{ html, selector, instruction }`
6. The server builds a prompt for Gemini:
   > "Here is an HTML document: [html]. The user selected [selector] and wants: [instruction]. Return the complete updated HTML only."
7. Gemini returns the rewritten HTML
8. The preview updates live — user can re-deploy or keep editing

## License
MIT
