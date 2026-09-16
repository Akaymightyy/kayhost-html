# Kayhost HTML — Paste HTML. Get a link.

Dead-simple HTML hosting. Paste HTML, get a live link in seconds. AI-powered visual editor included.

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
      allow create: if request.auth != null && request.auth.uid == uid;
      allow update: if request.auth != null && request.auth.uid == uid;
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
    match /settings/{key} {
      allow read: if true;
      allow write: if true;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

**Also enable sign-in providers:**
- Firebase Console → Authentication → Sign-in method
- Enable **Email/Password** (for admin login with kayhost@admin.com)
- Enable **Google** (add support email)
- Enable **GitHub** (you'll need a GitHub OAuth App — see Firebase docs)

**Create the admin account in Firebase Console:**
- Authentication → Users → Add User
- Email: `kayhost@admin.com`
- Password: `363436`
- This email is hardcoded as admin in `index.html` and `api/admin.js`

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

- `api/_firebase.js` — Firebase config (uses the client SDK, no service account needed)
- `api/ai-edit.js` — Gemini API key
- `api/media.js` — Cloudinary cloud name + upload preset

⚠️ Use a **private** GitHub repo if you push the code (so nobody can read your keys).

## How to get your Gemini API key
1. Go to https://aistudio.google.com/apikey
2. Create a key (starts with `AIza...`)
3. Open `api/ai-edit.js` → replace `"Kayhost_API_Key"` with your key

## Features

- ✅ **Paste & Deploy** — paste HTML → get live URL in seconds
- ✅ **Auto-Expiry** — 1d / 7d / 30d / never
- ✅ **AI Visual Editor** — click any element → describe change → Gemini rewrites HTML
- ✅ **Dashboard** — list your pages with expiry countdown
- ✅ **Image Uploads** — via Cloudinary
- ✅ **Dark theme** — black bg, yellow + purple accents (solid, no gradients)
