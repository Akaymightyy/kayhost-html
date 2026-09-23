// lib/ashna.js — shared AshnaAI logic used by both api/ashna-models.js (GET /models
// list for the frontend dropdown) and api/ai-edit.js (Pro-only chat calls).
//
// ENV VARS (server-only, NEVER in client code, logs, or localStorage):
//   ASHNA_API_KEY         — Bearer secret for api.ashna.ai (REQUIRED for any call)
//   ASHNA_ALLOWED_MODELS  — Comma-separated model IDs the admin has approved
//                           (allowlist; only these IDs ever get returned to clients)
//   ASHNA_DEFAULT_MODEL   — Optional default model ID (must also be in allowlist
//                           AND in the live /models response)
//   ASHNA_DAILY_LIMIT      — Per-user-per-day cap for Pro users (default 50)
//
// SECURITY:
//   - The API key never appears in any response, log, or client-visible string.
//   - The /models response is FILTERED: only IDs in BOTH ASHNA_ALLOWED_MODELS
//     and the live /models response are returned. A stale allowlist ID won't be
//     returned (and won't be callable from ai-edit either).
//   - We never claim which IDs are returned by the live API — if /models fails,
//     we return an empty list with a safe message and the frontend hides the
//     Ashna group.

const ASHNA_API_KEY = process.env.ASHNA_API_KEY || "";
const ASHNA_ALLOWED_MODELS_RAW = process.env.ASHNA_ALLOWED_MODELS || "";
const ASHNA_DEFAULT_MODEL = process.env.ASHNA_DEFAULT_MODEL || "";
const ASHNA_DAILY_LIMIT = parseInt(process.env.ASHNA_DAILY_LIMIT || "50", 10) || 50;
const ASHNA_BASE_URL = "https://api.ashna.ai/v1/api";

// In-memory cache for the /models response. Each Vercel function instance has
// its own cache (functions are isolated). Cache TTL is 10 minutes — short enough
// that newly-added allowlist IDs propagate quickly, long enough to avoid
// hammering Ashna on every page load.
let _cache = { at: 0, list: [], defaultModel: null, error: null };
const CACHE_TTL_MS = 10 * 60 * 1000;

// Convert a model ID into a friendly display name.
//   "glm-5.3-flash"    -> "GLM 5.3 Flash"
//   "claude-sonnet-5"  -> "Claude Sonnet 5"
//   "gpt-4.1-mini"     -> "GPT 4.1 Mini"
// Rules:
//   - Split on dashes/underscores -> words
//   - If word is all letters AND <= 3 chars -> uppercase all (acronym: GLM, GPT)
//   - If word starts with a digit -> keep as-is (version numbers)
//   - Otherwise -> capitalize first letter (Flash, Sonnet, Mini)
function friendlyName(id) {
  if (!id) return "";
  return String(id)
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .map(w => {
      if (/^\d/.test(w)) return w;                          // starts with digit → keep
      if (/^[A-Za-z]{1,3}$/.test(w)) return w.toUpperCase(); // short alpha → acronym
      return w.charAt(0).toUpperCase() + w.slice(1);         // else → Title case
    })
    .join(" ");
}

function parseAllowlist(raw) {
  return String(raw || "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// Fetch the live /models list from Ashna, intersect with the allowlist, and return
// a catalog safe to show to clients. Uses the in-memory cache.
// Returns: { list, defaultModel, error }
//   list          — Array of { id, displayName, capability, endpoint }
//   defaultModel  — String or null
//   error         — String or null (safe to expose; never includes the key)
async function fetchAshnaModels() {
  // Fast path: cache hit
  const now = Date.now();
  if (_cache.at && (now - _cache.at) < CACHE_TTL_MS) {
    return { list: _cache.list, defaultModel: _cache.defaultModel, error: _cache.error };
  }

  const allowlist = parseAllowlist(ASHNA_ALLOWED_MODELS_RAW);

  if (!ASHNA_API_KEY) {
    _cache = { at: now, list: [], defaultModel: null, error: "AshnaAI not configured" };
    return _cache;
  }
  if (allowlist.length === 0) {
    _cache = { at: now, list: [], defaultModel: null, error: "No AshnaAI models configured" };
    return _cache;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${ASHNA_BASE_URL}/models`, {
      headers: { "Authorization": `Bearer ${ASHNA_API_KEY}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      // Never include the status text — could leak provider details
      _cache = { at: now, list: [], defaultModel: null, error: "AshnaAI unavailable" };
      return _cache;
    }

    const data = await res.json();
    // OpenAI-compatible /models response: { data: [{ id: "..." }, ...] }
    // Some providers return a bare array. Handle both.
    const rawList = Array.isArray(data?.data) ? data.data
                 : Array.isArray(data) ? data
                 : [];

    // Build a case-insensitive + separator-normalized lookup of live IDs.
    // The user's ASHNA_ALLOWED_MODELS might use uppercase + underscores
    // (e.g. "GLM_5_3_FLASH") while the Ashna API returns lowercase + dashes
    // (e.g. "glm-5.3-flash"). We normalize BOTH sides to lowercase with
    // dashes before comparing so they match regardless of naming convention.
    const normalize = (id) => String(id || "").toLowerCase().replace(/[_\s]+/g, "-").replace(/-+/g, "-");
    const liveIdMap = new Map();  // normalizedId -> originalId
    rawList.forEach(m => {
      if (m && m.id) {
        const orig = String(m.id);
        liveIdMap.set(normalize(orig), orig);
      }
    });

    // Keep IDs in BOTH the allowlist AND the live response (case-insensitive match)
    const list = allowlist
      .filter(id => liveIdMap.has(normalize(id)))
      .map(id => ({
        // Use the ORIGINAL ID from the live response (not the allowlist variant)
        // so the frontend sends the exact ID the API expects.
        id: liveIdMap.get(normalize(id)),
        displayName: friendlyName(id),
        capability: "html-editing",
        endpoint: "chat-completions",
      }));

    // Default model must be in both the allowlist and the live response
    const defaultModel =
      ASHNA_DEFAULT_MODEL && liveIdMap.has(normalize(ASHNA_DEFAULT_MODEL))
        ? liveIdMap.get(normalize(ASHNA_DEFAULT_MODEL))
        : (list[0] ? list[0].id : null);

    _cache = {
      at: now,
      list,
      defaultModel,
      error: list.length === 0 ? "No AshnaAI models available" : null,
    };
    return _cache;
  } catch (err) {
    if (err.name === "AbortError") {
      _cache = { at: now, list: [], defaultModel: null, error: "AshnaAI timeout" };
    } else {
      _cache = { at: now, list: [], defaultModel: null, error: "AshnaAI unavailable" };
    }
    return _cache;
  }
}

// Validate that a model ID is in the cached catalog (which is itself the
// intersection of allowlist + live /models response). Case-insensitive +
// separator-normalized match (same logic as fetchAshnaModels).
// Returns boolean.
async function validateAshnaModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const { list } = await fetchAshnaModels();
  const normalize = (id) => String(id || "").toLowerCase().replace(/[_\s]+/g, "-").replace(/-+/g, "-");
  const target = normalize(modelId);
  return list.some(m => normalize(m.id) === target);
}

// Call Ashna's chat-completions endpoint. Throws an Error with a `.status`
// property (mapping Ashna's status to the HTTP we want to expose):
//   400/401/403/404 from Ashna -> status: 502, message: "AI provider error"
//   429 from Ashna              -> status: 429,  message: "AI provider rate-limited, try again shortly"
//   5xx from Ashna              -> status: 502, message: "AI provider error"
//   timeout                     -> status: 504, message: "AI provider timed out"
//   network error               -> status: 502, message: "AI provider error"
// The thrown Error.message is safe to expose — it never contains the key,
// auth headers, full HTML, or user data.
//
// Args:
//   model        — model ID, already validated against the catalog
//   systemPrompt — string (the "You are a precise HTML editor..." instruction)
//   userPrompt   — string (the existing editing prompt with the HTML in it)
//   options      — { timeoutMs } optional, defaults to 50000 (must be < vercel maxDuration)
// Returns: { text } — the model's response text (NOT yet fence-stripped or validated)
async function callAshnaChat(model, systemPrompt, userPrompt, options = {}) {
  if (!ASHNA_API_KEY) {
    const err = new Error("AshnaAI not configured");
    err.status = 503;
    throw err;
  }

  const timeoutMs = options.timeoutMs || 50000;  // 50s default; Vercel Hobby max is 60s
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${ASHNA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ASHNA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 16000,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Log the REAL Ashna response server-side (Vercel function logs) so it's
      // actually diagnosable — bad key, no credit, wrong model, etc. — without
      // exposing the raw provider response text to the client.
      let providerDetail = "";
      try { providerDetail = JSON.stringify(await res.clone().json()).slice(0, 500); }
      catch (e) { try { providerDetail = (await res.text()).slice(0, 500); } catch (e2) {} }
      console.error(`[ashna] HTTP ${res.status} calling ${ASHNA_BASE_URL} with model "${model}": ${providerDetail}`);

      // Map Ashna status to a safe, but now status-code-aware, client-facing message.
      let status = 502;
      let message = `AI provider error (HTTP ${res.status})`;
      if (res.status === 429) {
        status = 429;
        message = "AI provider rate-limited, try again shortly";
      } else if (res.status === 401 || res.status === 403) {
        status = 502;
        message = `AI provider rejected the request (HTTP ${res.status}) — check the Ashna API key on Vercel.`;
      } else if (res.status === 404) {
        status = 502;
        message = `AI provider error (HTTP 404) — model "${model}" may not exist on Ashna.`;
      }
      const err = new Error(message);
      err.status = status;
      throw err;
    }

    const data = await res.json();
    // OpenAI-compatible chat-completions response: { choices: [{ message: { content } }] }
    const text = data?.choices?.[0]?.message?.content || "";
    if (!text) {
      const err = new Error("AI provider returned empty response");
      err.status = 502;
      throw err;
    }
    return { text };
  } catch (err) {
    if (err.status) throw err;  // already-classified error from above
    if (err.name === "AbortError") {
      const e = new Error("AI provider timed out");
      e.status = 504;
      throw e;
    }
    // Network error, JSON parse error, etc.
    const e = new Error("AI provider error");
    e.status = 502;
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// Strip markdown code fences from a model response.
//   "```html\n<!DOCTYPE...>...</html>\n```"  -> "<!DOCTYPE...>...</html>"
//   "```\n<!DOCTYPE...>\n```"                -> "<!DOCTYPE...>"
// Also trims surrounding whitespace.
function stripCodeFences(text) {
  if (!text) return "";
  let t = String(text).trim();
  if (t.startsWith("```html")) {
    t = t.replace(/^```html\s*/, "").replace(/\s*```$/, "");
  } else if (t.startsWith("```")) {
    t = t.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  return t.trim();
}

// Validate that a string is complete HTML suitable for returning to the editor.
// Must be non-empty, contain <!DOCTYPE html> or <html>, and end with </html>.
// If the model wrapped explanation around the HTML, try to extract just the
// HTML part. Returns { ok: true, html } or { ok: false }.
function validateAndExtractHtml(text) {
  if (!text) return { ok: false };
  let t = stripCodeFences(text);
  if (!t) return { ok: false };

  // If the model added explanation before/after, try to extract the HTML block
  const lower = t.toLowerCase();
  if (!lower.includes("<!doctype") && !lower.startsWith("<html")) {
    const m = t.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
    if (m) {
      t = m[0];
    } else {
      return { ok: false };
    }
  }

  // Must end with </html> (allow trailing whitespace)
  if (!/<\/html>\s*$/i.test(t)) {
    return { ok: false };
  }
  return { ok: true, html: t };
}

module.exports = {
  friendlyName,
  parseAllowlist,
  fetchAshnaModels,
  validateAshnaModel,
  callAshnaChat,
  stripCodeFences,
  validateAndExtractHtml,
  // Exposed for tests only — never expose the key itself via this module
  _isConfigured: () => !!ASHNA_API_KEY,
  _dailyLimit: () => ASHNA_DAILY_LIMIT,
};
