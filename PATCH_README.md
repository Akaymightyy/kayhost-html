# KayHost HTML — Patch v2 (Sept 25, 2026)

## What this patch fixes

### The disappearing panel bug (FINALLY fixed)

**Root cause:** When you clicked "Apply Changes" in the FLOATING edit box (the small one that appears near the clicked element), `applyFloatingEdit()` called `hideFloatingEditBox()` IMMEDIATELY — then `applyAiEdit()` ran and showed the loading banner in the MAIN AI panel, which you couldn't see because you were using the floating box. So everything went invisible.

**The fix:** `applyFloatingEdit()` no longer hides the floating box during loading. Instead:
1. The floating box stays visible
2. The "Apply Changes" button text changes to "Generating…" and dims
3. A purple status banner appears at the top of the floating box: "Generating… the AI is rewriting your HTML."
4. On success → the floating box hides (normal behavior)
5. On error → the floating box STAYS visible, the banner turns red with the error message, and the Apply button re-enables so you can retry

## Files in this patch

| File | Action |
|---|---|
| `index.html` | Replace — fixes `applyFloatingEdit()` to show loading state in the floating box |
| `README.md` | Replace — full rewrite reflecting v44 (multi-provider AI, click-to-edit UX, consolidated API, etc.) |

## How to apply

1. Unzip this patch
2. Replace `index.html` with the new version
3. Replace `README.md` with the new version
4. Commit and push — Vercel auto-deploys

## After deploying

- Click any element in the preview → floating box appears → type instruction → click "Apply Changes"
- The floating box should now STAY VISIBLE with a purple "Generating…" banner
- On success it hides. On error it stays and shows the error in red.
- The main AI panel (click the "AI" button in the toolbar) also still works with its own status banner.
