// lib/ai-providers.js — shared config for OpenRouter AI provider.
//
// ENV VARS (server-only):
//   OPENROUTER_API_KEY — enables OpenRouter models (FREE tier, not Pro-gated)
//
// OpenRouter model list is DYNAMIC — fetched from the live /models endpoint,
// filtered for free models (pricing.prompt === "0"), cached 30 min.

// ===== OpenRouter free model fallback (used only if the live fetch fails) =====
// These are safety-net model IDs that have been stable for a long time.
// If the dynamic fetch works, these are NOT used.
const OPENROUTER_FALLBACK_MODELS = [
  { id: "meta-llama/llama-3.3-70b-instruct:free", displayName: "Llama 3.3 70B (Free)" },
  { id: "z-ai/glm-5.2:free",                     displayName: "GLM 5.2 (Free)" },
  { id: "qwen/qwen3.8-27b:free",                 displayName: "Qwen 3.8 27B (Free)" },
];

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// ===== Dynamic OpenRouter free model cache =====
// Fetches /models, filters for free (pricing.prompt === "0"), caches 30 min.
let _openrouterCache = { at: 0, models: [] };
const OPENROUTER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Convert an OpenRouter model ID to a display name.
function openrouterDisplayName(id) {
  if (!id) return "Unknown";
  let name = id.replace(/:free$/, "");
  const slashIdx = name.lastIndexOf("/");
  if (slashIdx >= 0) name = name.slice(slashIdx + 1);
  name = name.replace(/[-_]/g, " ").trim();
  name = name.split(/\s+/).map(w => {
    if (/^\d/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
  return name + " (Free)";
}

async function fetchOpenRouterFreeModels() {
  const now = Date.now();
  if (_openrouterCache.models.length > 0 && (now - _openrouterCache.at) < OPENROUTER_CACHE_TTL_MS) {
    return _openrouterCache.models;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn("[ai-providers] OpenRouter /models returned HTTP " + res.status + " — using fallback");
      return OPENROUTER_FALLBACK_MODELS;
    }
    const data = await res.json();
    const allModels = Array.isArray(data?.data) ? data.data : [];
    const freeModels = allModels.filter(m => {
      const p = m.pricing || {};
      return p.prompt === "0" && p.completion === "0";
    });
    if (freeModels.length === 0) {
      console.warn("[ai-providers] OpenRouter has 0 free models — using fallback");
      return OPENROUTER_FALLBACK_MODELS;
    }
    freeModels.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
    const top = freeModels.slice(0, 10).map(m => ({
      id: m.id,
      displayName: openrouterDisplayName(m.id),
    }));
    _openrouterCache = { at: now, models: top };
    console.log("[ai-providers] OpenRouter free models fetched:", top.length, "models");
    return top;
  } catch (err) {
    console.warn("[ai-providers] OpenRouter /models fetch failed:", err.message, "— using fallback");
    return OPENROUTER_FALLBACK_MODELS;
  }
}

// Returns which providers are currently enabled (based on env vars).
async function getEnabledProviders() {
  const providers = [];
  if (process.env.OPENROUTER_API_KEY) {
    const freeModels = await fetchOpenRouterFreeModels();
    providers.push({
      id: "openrouter",
      label: "OpenRouter (Free)",
      models: freeModels.map(m => ({ ...m, capability: "html-editing", endpoint: "chat-completions" })),
    });
  }
  return providers;
}

function makeError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function callProvider(providerId, model, systemPrompt, userPrompt, options = {}) {
  let baseUrl, apiKey;
  if (providerId === "openrouter") {
    baseUrl = OPENROUTER_BASE_URL;
    apiKey = process.env.OPENROUTER_API_KEY;
  } else {
    throw makeError("Unknown AI provider", 400);
  }

  if (!apiKey) {
    throw makeError("AI provider not configured", 503);
  }

  const timeoutMs = options.timeoutMs || 50000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (providerId === "openrouter") {
      headers["HTTP-Referer"] = "https://kayhosthtml.zone.id";
      headers["X-Title"] = "Kayhost HTML";
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
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
      let errorBody = "";
      try { errorBody = await res.text(); } catch (e) {}
      if (errorBody.includes("<!doctype html>") || errorBody.includes("<html")) {
        throw makeError(providerId + " API is behind a web firewall.", 502);
      }
      console.error("[ai-providers] " + providerId + " API error:", res.status, errorBody.slice(0, 500));
      let status = 502;
      let message = "";
      if (res.status === 429) {
        status = 429;
        message = "This free model hit its daily limit — try another model from the dropdown.";
      } else if (res.status === 402) {
        status = 502;
        message = "Payment required — shouldn't happen with free models.";
      } else if (res.status === 401) {
        status = 503;
        message = providerId + " API key is invalid.";
      } else if (res.status === 403) {
        status = 503;
        message = providerId + " API key doesn't have permission.";
      } else if (res.status === 404) {
        status = 502;
        message = providerId + " model '" + model + "' not found. It may have been deprecated — refresh the page to get the latest model list.";
      } else if (res.status >= 500) {
        status = 502;
        message = providerId + " server error (HTTP " + res.status + ").";
      } else {
        status = 502;
        message = providerId + " returned HTTP " + res.status + ".";
      }
      throw makeError(message, status);
    }

    const responseText = await res.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      const trimmed = responseText.trim().toLowerCase();
      if (trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html")) {
        throw makeError(providerId + " returned an HTML error page instead of JSON (likely a gateway or firewall block).", 502);
      }
      throw makeError(providerId + " returned invalid response.", 502);
    }
    const text = data?.choices?.[0]?.message?.content || "";
    if (!text) {
      throw makeError("AI provider returned empty response", 502);
    }
    return { text };
  } catch (err) {
    if (err.status) throw err;
    if (err.name === "AbortError") {
      throw makeError("AI provider timed out", 504);
    }
    throw makeError("AI provider error", 502);
  } finally {
    clearTimeout(timeout);
  }
}

// Validate model against the provider's catalog.
async function validateModel(providerId, modelId) {
  if (!providerId || !modelId) return false;
  if (providerId === "openrouter") {
    const models = await fetchOpenRouterFreeModels();
    return models.some(m => m.id === modelId);
  }
  return false;
}

module.exports = {
  OPENROUTER_FALLBACK_MODELS,
  getEnabledProviders,
  callProvider,
  validateModel,
};
