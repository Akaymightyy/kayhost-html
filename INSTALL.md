# kayhost-upgrade — 4 New Features for kayhost-html

This package adds **4 new features** to your kayhost-html project:

1. **AI site generation from prompt** — describe a site → AI builds it
2. **Forms backend** — contact forms with no backend needed
3. **Custom domains** (Pro feature) — connect your own domain
4. **Multi-page folder upload UI** — drag a folder → multi-page site (your backend already supports this)

---

## What's in this package

```
kayhost-upgrade/
├── INSTALL.md                     ← This file (READ FIRST)
├── api/
│   ├── ai-generate.js             ← NEW — AI site generation endpoint
│   ├── forms.js                   ← NEW — Form submission endpoint
│   └── custom-domains.js          ← NEW — Custom domain CRUD + verify
├── lib/                           (empty — using existing lib/firebase.js)
├── vercel.json                    ← REPLACE your existing one
├── middleware.js                  ← REPLACE your existing one
├── patches/
│   ├── api-main-additions.js      ← ADD 2 routes to your api/main.js
│   └── index-html-additions.html  ← ADD this block to your index.html
└── firestore-rules.txt            ← UPDATE your Firestore rules
```

---

## Installation steps (10 minutes total)

### Step 1: Add the 3 new API files

Copy these files into your repo's `api/` folder:

```bash
cp api/ai-generate.js       /path/to/kayhost-html/api/
cp api/forms.js             /path/to/kayhost-html/api/
cp api/custom-domains.js    /path/to/kayhost-html/api/
```

After this, your `api/` folder should have:
```
api/
├── ai-edit.js          (existing)
├── ai-generate.js      ← NEW
├── ai-providers.js     (existing)
├── admin.js            (existing)
├── ashna-models.js     (existing)
├── auth.js             (existing)
├── custom-domains.js   ← NEW
├── forms.js            ← NEW
├── main.js             (existing — you'll patch this)
├── serve.js            (existing)
└── site/[id].js        (existing)
```

### Step 2: Replace vercel.json

```bash
cp vercel.json /path/to/kayhost-html/vercel.json
```

This adds the new routes:
- `/api/ai-generate` → `/api/ai-generate.js`
- `/form/:siteId` → `/api/forms.js?route=submit&siteId=:siteId` (public form post)
- `/api/forms/:siteId/submissions` → `/api/forms.js?route=list&siteId=:siteId` (owner list)
- `/api/custom-domains` → `/api/custom-domains.js`

### Step 3: Replace middleware.js

```bash
cp middleware.js /path/to/kayhost-html/middleware.js
```

This adds **custom domain detection** — when a request comes in with a Host header that isn't `kayhosthtml.zone.id`, the middleware rewrites it to `/api/main?route=custom-domain-serve&host=...` so we can look up the site by domain.

### Step 4: Patch api/main.js (add 2 new routes)

Open `api/main.js` in your editor. Find the line that says `switch (route) {` (it's the route dispatcher). Add these two cases inside the switch block:

```js
case "custom-domain-serve": return handleCustomDomainServe(req, res);
case "form-count": return handleFormCount(req, res);
```

Then at the **bottom of the file** (before `module.exports` if any), paste the entire content of `patches/api-main-additions.js` (excluding the comment block at the top).

The file `patches/api-main-additions.js` contains:
- `handleCustomDomainServe()` — looks up a site by Host header (for custom domains)
- `handleFormCount()` — returns the number of form submissions for a site (for the dashboard badge)

### Step 5: Patch index.html (add the UI)

Open `index.html` in your editor. Find the closing `</body>` tag. Paste the entire content of `patches/index-html-additions.html` right before `</body>`.

This adds 3 modal dialogs and the JavaScript to drive them:
- AI Generate modal (with example prompts)
- Forms snippet generator modal (with copy-to-clipboard)
- Custom domains modal (with add/verify/delete)

It also hooks into your existing folder-upload input to detect multi-page uploads (2+ HTML files) and route them to `/api/multi-deploy` (your existing multi-page endpoint).

### Step 6: Update Firestore rules

Go to **Firebase Console → Firestore Database → Rules**. Paste the content of `firestore-rules.txt` and click **Publish**.

This adds 2 new collection rules:
- `formSubmissions` — public write (anyone can submit), server-only read
- `customDomains` — server-only read/write (via Admin SDK)

### Step 7: Add environment variables (optional but recommended)

In **Vercel → your project → Settings → Environment Variables**, add these (all optional):

| Variable | Purpose | Required for |
|---|---|---|
| `GEMINI_API_KEY` | Already set (your existing key works) | AI Generate (Gemini branch) |
| `RESEND_API_KEY` | Resend.com API key for email notifications | Form email alerts |
| `FORM_NOTIFY_EMAIL` | Email address to notify on new form submissions | Form email alerts |
| `VERCEL_TOKEN` | Vercel API token (auto-add custom domains) | Custom domains (auto-provisioning) |
| `VERCEL_PROJECT_ID` | Your Vercel project ID | Custom domains (auto-provisioning) |
| `VERCEL_TEAM_ID` | Your Vercel team ID (if applicable) | Custom domains (auto-provisioning) |

If you skip the Resend/VERCEL vars:
- Form submissions will still be stored in Firestore (you'll see them in the dashboard)
- Custom domains will need to be **manually added to Vercel** by you (admin) after DNS verification

### Step 8: Commit and deploy

```bash
cd /path/to/kayhost-html
git add .
git commit -m "feat: add AI generate, forms backend, custom domains, multi-page UI"
git push origin main
```

Vercel will auto-deploy. After deploy completes:

- ✅ Visit your site → "Generate with AI" button appears in the New view
- ✅ Drag a folder with 2+ HTML files → multi-page deploy auto-triggers
- ✅ Forms posted to `/form/:siteId` will be stored in Firestore
- ✅ Pro users can add custom domains in the dashboard

---

## How each feature works

### 1. AI site generation

**User flow:**
1. User clicks "Generate with AI" button (next to "New site")
2. Modal opens with a textarea and 4 example prompts (Coffee shop, Dev portfolio, Wedding invite, Fashion brand)
3. User types a description or clicks an example
4. Clicks "Generate" → AI returns a complete HTML page
5. Page loads into the editor → user can edit + deploy

**Endpoint:** `POST /api/ai-generate`
```json
{ "prompt": "Build a portfolio for my design work", "browserId": "user-xyz", "provider": "gemini" }
```
Returns: `{ "html": "<!DOCTYPE html>...</html>" }`

**Quota:** 50/day per browserId (shared with ai-edit). BYOK supported (provider: "byok", apiKey: "...").

### 2. Forms backend

**User flow:**
1. User opens "Add a contact form" modal (in the editor toolbar)
2. Enters their site ID → modal generates an HTML snippet
3. User copies the snippet and pastes it into their HTML
4. When visitors submit the form, it POSTs to `https://kayhosthtml.zone.id/form/SITE_ID`
5. Submissions are stored in Firestore `formSubmissions` collection
6. Site owner can view submissions via `GET /api/forms/:siteId/submissions` (auth required)

**Snippet format:**
```html
<form action="https://kayhosthtml.zone.id/form/abc123" method="POST">
  <input type="hidden" name="_redirect" value="https://yoursite.com/thanks">
  <input type="text" name="_gotcha" style="display:none !important">  <!-- honeypot -->
  <input type="text" name="name" required>
  <input type="email" name="email" required>
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>
```

**Features:**
- ✅ Accepts JSON, urlencoded, and multipart form data
- ✅ Honeypot field (`_gotcha`) silently drops bot submissions
- ✅ Optional `_redirect` field to redirect after submit (for non-AJAX forms)
- ✅ Optional email notification via Resend
- ✅ 100 KB max submission size
- ✅ Each field value capped at 10,000 chars

### 3. Custom domains

**User flow:**
1. Pro user opens "Custom domain" modal from their site's dashboard
2. Enters their domain (e.g. `mybrand.com`)
3. We generate a unique TXT verification token and store the domain as "pending"
4. User adds DNS records:
   - `CNAME mybrand.com → kayhosthtml.zone.id`
   - `TXT @ → kayhost-verify=abc123def456`
5. User clicks "Verify now" → we do DNS lookup, check TXT matches
6. If verified → status changes to "verified"
7. **Auto-add to Vercel** (if `VERCEL_TOKEN` set) OR admin manually adds the domain to Vercel project
8. Once Vercel provisions SSL, requests to `mybrand.com` hit our middleware
9. Middleware detects custom domain → rewrites to `/api/main?route=custom-domain-serve&host=mybrand.com`
10. `handleCustomDomainServe` looks up the site by host and serves its HTML

**Endpoint:** `POST /api/custom-domains` (auth required, Pro-only)
```json
{ "siteId": "abc123", "domain": "mybrand.com" }
```
Returns: `{ "id": "...", "status": "pending", "txtRecord": "kayhost-verify=...", "instructions": {...} }`

### 4. Multi-page folder upload

**User flow:**
1. User drags a folder containing 2+ HTML files (e.g. `index.html`, `about.html`, `contact.html`) onto the upload zone
2. JavaScript detects 2+ HTML files → builds a `files` object with relative paths
3. POSTs to `/api/multi-deploy` (your existing endpoint)
4. Backend stores as a multi-page project (using your existing `lib/multipage.js`)
5. Returns URL like `https://kayhosthtml.zone.id/p/abc123/`
6. Visiting that URL serves `index.html`; `/p/abc123/about` serves `about.html`

**No backend changes needed** — your existing `lib/multipage.js`, `/api/multi-deploy` route, and `/p/:id/:path*` rewrite already handle this. This package just adds the **frontend UI** to trigger it.

---

## Testing each feature after deploy

### Test AI Generate
```bash
curl -X POST https://kayhosthtml.zone.id/api/ai-generate \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 ..." \
  -d '{"prompt":"Build a landing page for a coffee shop","browserId":"test-1","provider":"gemini"}'
```
Should return `{ "html": "<!DOCTYPE html>..." }`.

### Test Forms
```bash
# Submit a form
curl -X POST https://kayhosthtml.zone.id/form/test-site-id \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 ..." \
  -d '{"name":"Test User","email":"test@example.com","message":"Hello!"}'

# Should return: { "ok": true, "id": "auto-generated-id" }
```

### Test Custom Domains
```bash
# Requires auth token from a Pro user
TOKEN="eyJhbGc..."  # your Firebase ID token

# Request a custom domain
curl -X POST https://kayhosthtml.zone.id/api/custom-domains \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "User-Agent: Mozilla/5.0 ..." \
  -d '{"siteId":"abc123","domain":"mybrand.com"}'

# List your custom domains
curl https://kayhosthtml.zone.id/api/custom-domains \
  -H "Authorization: Bearer $TOKEN" \
  -H "User-Agent: Mozilla/5.0 ..."
```

### Test Multi-page
Open your site, drag a folder with 2+ HTML files onto the upload zone. Should deploy to `/p/<id>/`.

---

## Troubleshooting

### "AI did not return valid HTML"
- The AI sometimes returns markdown-fenced code. We strip it, but if it fails, try a more specific prompt.
- BYOK mode: ensure your API key is valid and has Gemini access.

### "Custom domain stuck at pending"
- DNS propagation takes 5-30 minutes. Wait and click "Verify" again.
- Check the TXT record with: `dig TXT mybrand.com` (should show `kayhost-verify=...`)
- Check the CNAME with: `dig mybrand.com` (should point to `kayhosthtml.zone.id`)

### "Custom domain verified but not serving"
- You need to add the domain to your Vercel project manually (or set `VERCEL_TOKEN` + `VERCEL_PROJECT_ID` env vars for auto-add).
- Vercel dashboard → your project → Settings → Domains → Add.

### "Form submissions not appearing in dashboard"
- The dashboard UI for viewing submissions is not included in this package (would require more frontend work).
- You can view submissions directly in Firebase Console → Firestore → `formSubmissions` collection.
- Or use the API: `GET /api/forms/:siteId/submissions` with your auth token.

### Multi-page folder upload not triggering
- The JS hook looks for `input[webkitdirectory]`, `input[type="file"][multiple]`, or `.folder-upload input`.
- If your folder upload uses a different selector, you'll need to adjust the `folderInputs` query in `patches/index-html-additions.html`.
- Check the browser console for errors.

---

## What's NOT included (future work)

- **Dashboard UI for form submissions** — currently viewable via Firebase Console or API only
- **Email notification template customization** — uses a fixed template in `api/forms.js`
- **Custom domain SSL status check** — Vercel handles SSL automatically once the domain is added
- **Multi-page project editor** — you can deploy multi-page sites, but editing them page-by-page in the UI is not yet supported (would need a separate project editor)
- **AI generate with image generation** — currently text-only (HTML/CSS). Image AI would need a separate integration.

---

## Files changed summary

| File | Action | Notes |
|---|---|---|
| `api/ai-generate.js` | NEW | AI site generation endpoint |
| `api/forms.js` | NEW | Form submission endpoint |
| `api/custom-domains.js` | NEW | Custom domain CRUD + verify |
| `vercel.json` | REPLACE | Adds new route rewrites |
| `middleware.js` | REPLACE | Adds custom domain detection |
| `api/main.js` | PATCH | Add 2 cases + 2 handler functions (see patches/api-main-additions.js) |
| `index.html` | PATCH | Add UI block before `</body>` (see patches/index-html-additions.html) |
| Firestore rules | UPDATE | Add formSubmissions + customDomains collections |

**That's it.** After these 8 changes, all 4 features are live.

---

## Questions?

If anything breaks, tell me which step failed and what error you got. I'll help fix it.
