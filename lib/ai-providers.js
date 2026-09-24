// lib/ai-providers.js — shared config for OpenCode Zen and OpenRouter AI providers.
// Both are OpenAI-compatible chat-completions APIs.
//
// ENV VARS (server-only, never in client code):
//   OPENCODE_API_KEY   — enables OpenCode Zen models
//   OPENROUTER_API_KEY — enables OpenRouter models
//
// Each provider's models only show in the dropdown if its own key is set.

// ===== OpenCode Zen model catalog =====
const OPENCODE_MODELS = [
  { id: "deepseek-v4-flash-free", displayName: "DeepSeek V4 Flash" },
  { id: "mimo-v2.5-free",         displayName: "MiMo V2.5" },
  { id: "qwen3.6-plus",           displayName: "Qwen 3.6 Plus" },
  { id: "minimax-m3",             displayName: "MiniMax M3" },
  { id: "big-pickle",             displayName: "Big Pickle" },
];

// ===== OpenRouter model catalog — ALL FREE MODELS (no 402 "payment required") =====
// NOTE: Free models (:free suffix) are $0/token but rate-limited to ~50-200 requests/day
// depending on account credit history. If a model hits its daily limit (429), the user
// should try another free model. Do NOT switch back to paid models without credits.
// Model IDs verified against https://openrouter.ai/api/v1/models (live API, Sep 2026).
const OPENROUTER_MODELS = [
  { id: "z-ai/glm-4.5-air:free",              displayName: "GLM 4.5 Air (Free)" },
  { id: "qwen/qwen3-coder:free",               displayName: "Qwen3 Coder (Free)" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", displayName: "Nemotron Ultra (Free)" },
  { id: "openai/gpt-oss-120b:free",            displayName: "GPT-OSS 120B (Free)" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", displayName: "Llama 3.3 70B (Free)" },
];

const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Returns which providers are currently enabled (based on env vars).
function getEnabledProviders() {
  const providers = [];
  if (process.env.OPENCODE_API_KEY) {
    providers.push({
      id: "opencode",
      label: "OpenCode Zen",
      models: OPENCODE_MODELS.map(m => ({ ...m, capability: "html-editing", endpoint: "chat-completions" })),
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    providers.push({
      id: "openrouter",
      label: "OpenRouter",
      models: OPENROUTER_MODELS.map(m => ({ ...m, capability: "html-editing", endpoint: "chat-completions" })),
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
  if (providerId === "opencode") {
    baseUrl = OPENCODE_BASE_URL;
    apiKey = process.env.OPENCODE_API_KEY;
  } else if (providerId === "openrouter") {
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
    // OpenRouter recommends HTTP-Referer and X-Title headers for rankings
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
        console.error("[ai-providers] " + providerId + " returned HTML (WAF/firewall), not JSON");
        throw makeError(providerId + " API is behind a web firewall that blocks server-side requests.", 502);
      }
      console.error("[ai-providers] " + providerId + " API error:", res.status, errorBody.slice(0, 500));
      let status = 502;
      let message = "";
      if (res.status === 429) {
        status = 429;
        message = "This free model hit its daily limit — try another model from the dropdown.";
      } else if (res.status === 402) {
        status = 502;
        message = "Payment required — this shouldn't happen with free models. Check your OpenRouter account credits.";
      } else if (res.status === 401) {
        status = 503;
        message = providerId + " API key is invalid. Check env var: " + (providerId === "opencode" ? "OPENCODE_API_KEY" : "OPENROUTER_API_KEY");
      } else if (res.status === 403) {
        status = 503;
        message = providerId + " API key doesn't have permission. Check your account settings.";
      } else if (res.status === 404) {
        status = 502;
        message = providerId + " model '" + model + "' not found. Check the model ID.";
      } else if (res.status >= 500) {
        status = 502;
        message = providerId + " server is down (HTTP " + res.status + "). Try again later.";
      } else {
        status = 502;
        message = providerId + " returned HTTP " + res.status + ". Check Vercel logs.";
      }
      throw makeError(message, status);
    }

    const responseText = await res.text();
    if (responseText.includes("<!doctype html>") || responseText.includes("<html")) {
      throw makeError(providerId + " returned HTML instead of JSON.", 502);
    }
    let data;
    try { data = JSON.parse(responseText); } catch (e) {
      throw makeError(providerId + " returned invalid response. Check Vercel logs.", 502);
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

function validateModel(providerId, modelId) {
  if (!providerId || !modelId) return false;
  const models = providerId === "opencode" ? OPENCODE_MODELS
               : providerId === "openrouter" ? OPENROUTER_MODELS
               : [];
  return models.some(m => m.id === modelId);
}

module.exports = {
  OPENCODE_MODELS,
  OPENROUTER_MODELS,
  getEnabledProviders,
  callProvider,
  validateModel,
};
