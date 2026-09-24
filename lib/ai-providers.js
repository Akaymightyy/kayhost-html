// lib/ai-providers.js — shared config for OpenCode Zen and AgentRouter AI providers.
// Both are OpenAI-compatible chat-completions APIs.
//
// ENV VARS (server-only, never in client code):
//   OPENCODE_API_KEY    — enables OpenCode Zen models
//   AGENTROUTER_API_KEY — enables AgentRouter models
//
// Each provider's models only show in the dropdown if its own key is set.
// If neither key is set, neither provider shows. If both are set, both show.
//
// These are FREE-tier providers (same as Gemini) — not Pro-gated. They share
// the same 10-edits/day browserId limit as Gemini.

// ===== OpenCode Zen model catalog =====
const OPENCODE_MODELS = [
  { id: "deepseek-v4-flash-free", displayName: "DeepSeek V4 Flash" },
  { id: "mimo-v2.5-free",         displayName: "MiMo V2.5" },
  { id: "qwen3.6-plus-free",      displayName: "Qwen 3.6 Plus" },
  { id: "minimax-m3-free",        displayName: "MiniMax M3" },
  { id: "big-pickle",             displayName: "Big Pickle" },
];

// ===== AgentRouter model catalog =====
const AGENTROUTER_MODELS = [
  { id: "agentrouter/glm-4.5",                    displayName: "GLM 4.5" },
  { id: "agentrouter/glm-4.6",                    displayName: "GLM 4.6" },
  { id: "agentrouter/claude-3-5-haiku-20241022",   displayName: "Claude 3.5 Haiku" },
  { id: "agentrouter/claude-3-5-sonnet-20241022",  displayName: "Claude 3.5 Sonnet" },
];

const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
const AGENTROUTER_BASE_URL = "https://agentrouter.org/v1";

// Returns which providers are currently enabled (based on env vars).
// Safe to expose to the frontend — never includes API keys.
function getEnabledProviders() {
  const providers = [];
  if (process.env.OPENCODE_API_KEY) {
    providers.push({
      id: "opencode",
      label: "OpenCode Zen",
      models: OPENCODE_MODELS.map(m => ({
        ...m,
        capability: "html-editing",
        endpoint: "chat-completions",
      })),
    });
  }
  if (process.env.AGENTROUTER_API_KEY) {
    providers.push({
      id: "agentrouter",
      label: "AgentRouter",
      models: AGENTROUTER_MODELS.map(m => ({
        ...m,
        capability: "html-editing",
        endpoint: "chat-completions",
      })),
    });
  }
  return providers;
}

// Make a safe Error with a status property (same convention as lib/ashna.js)
function makeError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Call a provider's chat-completions endpoint.
// Returns { text } on success. Throws Error with .status on failure.
// Never logs the API key, auth headers, or full HTML.
async function callProvider(providerId, model, systemPrompt, userPrompt, options = {}) {
  let baseUrl, apiKey;
  if (providerId === "opencode") {
    baseUrl = OPENCODE_BASE_URL;
    apiKey = process.env.OPENCODE_API_KEY;
  } else if (providerId === "agentrouter") {
    baseUrl = AGENTROUTER_BASE_URL;
    apiKey = process.env.AGENTROUTER_API_KEY;
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
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
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
      // Log the actual error for debugging (Vercel logs) — never logs the API key
      let errorBody = "";
      try { errorBody = await res.text(); } catch (e) {}
      console.error("[ai-providers] " + providerId + " API error:", res.status, errorBody.slice(0, 500));
      // Return SPECIFIC error messages so the user knows what's wrong
      let status = 502;
      let message = "";
      if (res.status === 429) {
        status = 429;
        message = providerId + " is rate-limited. Try again in a minute.";
      } else if (res.status === 401) {
        status = 503;
        message = providerId + " API key is invalid. Check the env var: " + (providerId === "opencode" ? "OPENCODE_API_KEY" : "AGENTROUTER_API_KEY");
      } else if (res.status === 403) {
        status = 503;
        message = providerId + " API key doesn't have permission. Check your account settings.";
      } else if (res.status === 404) {
        status = 502;
        message = providerId + " model '" + model + "' not found. The model ID may be wrong.";
      } else if (res.status >= 500) {
        status = 502;
        message = providerId + " server is down (HTTP " + res.status + "). Try again later.";
      } else {
        status = 502;
        message = providerId + " returned HTTP " + res.status + ". Check Vercel logs for details.";
      }
      throw makeError(message, status);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    if (!text) {
      throw makeError("AI provider returned empty response", 502);
    }
    return { text };
  } catch (err) {
    if (err.status) throw err;  // already classified
    if (err.name === "AbortError") {
      throw makeError("AI provider timed out", 504);
    }
    throw makeError("AI provider error", 502);
  } finally {
    clearTimeout(timeout);
  }
}

// Validate that a model ID is in the provider's static catalog.
// Returns boolean. Used by the server to reject unknown model IDs.
function validateModel(providerId, modelId) {
  if (!providerId || !modelId) return false;
  const models = providerId === "opencode" ? OPENCODE_MODELS
               : providerId === "agentrouter" ? AGENTROUTER_MODELS
               : [];
  return models.some(m => m.id === modelId);
}

module.exports = {
  OPENCODE_MODELS,
  AGENTROUTER_MODELS,
  getEnabledProviders,
  callProvider,
  validateModel,
};
