# KayHost HTML — Patch (Sept 25, 2026)

## What this patch fixes

### 1. Free quota raised from 10 → 50 per provider
**File:** `api/ai-edit.js`

- `FREE_DAILY_LIMIT` changed from `10` to `50`
- Each provider now has its OWN independent 50/day counter:
  - Gemini: 50 edits/day (doc id: `browserId_gemini_YYYY-MM-DD`)
  - OpenRouter: 50 edits/day (doc id: `browserId_openrouter_YYYY-MM-DD`)
- Previously Gemini and OpenRouter SHARED a single 10/day counter — using 5 Gemini edits meant you only had 5 OpenRouter edits left. Now they're separate.
- Pro providers (OpenCode Zen, Ashna) already had 50/day — unchanged.
- Error messages updated to mention the other free provider as an alternative.

### 2. Ashna provider gets Claude's JSON-parse-first fix
**File:** `lib/ashna.js`

- Previously `callAshnaChat()` called `res.json()` directly. If the upstream returned an HTML error page (firewall block, 5xx gateway), this threw an unhelpful "invalid JSON" error.
- Now it follows the same pattern Claude applied to `lib/ai-providers.js`:
  1. Read the response as text first
  2. Try `JSON.parse()` — if it succeeds, trust it (even if the content mentions `<html>`)
  3. Only if parse fails, check if the body STARTS with `<!doctype html` or `<html` (not "contains it anywhere")
  4. If yes → clear "HTML error page" message. If no → "invalid response" message.

### 3. Loading state on "Apply" — panel no longer disappears silently
**File:** `index.html`

**The bug:** Clicking "Apply" set a tiny spinner on the button, but:
- The spinner was hard to see
- Clicking the overlay or pressing Escape would close the panel mid-request
- After success, only a brief toast appeared — easy to miss

**The fix:**
- Added `_aiLoading` flag that prevents `closeAiPanel()` from closing the panel while a request is in flight
- Added a visible status banner inside the AI panel with three states:
  - **Loading** (purple, spinner): "Generating… the AI is rewriting your HTML. This usually takes 5-15 seconds."
  - **Success** (green, "OK"): "Change applied. The preview has been updated."
  - **Error** (red, "!"): Shows the actual error message, e.g. "You've used all 50 free OpenRouter edits for today..."
- The banner stays visible after success/error so the user always knows what happened
- The panel cannot be closed (via overlay click or X button) while loading

### 4. Dead file flagged for deletion
**File:** `ai-providers.js` (project root)

Claude flagged this — it's a stale older version that references "AgentRouter" (the old name) and has the original HTML false-positive bug. Nothing imports it (the real file is `lib/ai-providers.js`).

**Action:** Delete `ai-providers.js` from the project root. It's not imported anywhere — confirmed by grepping the codebase.

---

## Files in this patch

| File | Action |
|---|---|
| `api/ai-edit.js` | Replace — quota 10→50, per-provider counter, better error messages |
| `lib/ashna.js` | Replace — JSON-parse-first fix (same as Claude did for OpenRouter) |
| `index.html` | Replace — loading banner + panel lock during generation |
| `ai-providers.js` (root) | DELETE — dead code, nothing imports it |

---

## How to apply

1. Unzip this patch
2. Replace `api/ai-edit.js` with the new version
3. Replace `lib/ashna.js` with the new version
4. Replace `index.html` with the new version
5. **Delete** `ai-providers.js` from the project root (the one OUTSIDE `lib/` and `api/`)
6. Commit and push — Vercel auto-deploys

## After deploying

- Test with an OpenRouter model — should now work without false-positive HTML errors
- Test the Apply button — you should see a purple "Generating…" banner that doesn't disappear
- Test the quota — you now get 50 Gemini + 50 OpenRouter per day (100 total free edits)
- Watch Vercel logs for `[ai-edit]` and `[ashna]` lines to confirm everything's flowing
