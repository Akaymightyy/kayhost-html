// tests/ashna.test.js — Node test runner covering the Ashna provider integration.
//
// Run with: `node --test tests/ashna.test.js`
//
// Uses Node's built-in test runner (node:test) + node:assert. No external deps.
//
// Mocking strategy:
//   - Global `fetch` is overridden per-test to return canned responses.
//   - `lib/firebase.js`, `lib/admin-firebase.js`, `@google/genai` are stubbed
//     by pre-populating `require.cache` before requiring the module under test.
//   - `lib/ashna.js` is loaded for real (its logic IS the thing being tested
//     for most cases), with global `fetch` mocked.

const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");

// --- Helpers to build mock req/res objects ---
function makeMockReq({ method = "POST", body = {}, headers = {}, query = {} } = {}) {
  // Default User-Agent to a realistic browser UA so the scraper-blocker
  // in the real handlers doesn't 403 our test requests.
  const defaultHeaders = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
  return {
    method,
    headers: Object.assign({}, defaultHeaders, headers || {}),
    body,
    query,
    url: "/api/ai-edit",
  };
}

function makeMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    setStatus: function (c) { this.statusCode = c; return this; },
    status: function (c) { this.statusCode = c; return this; },
    setHeader: function (k, v) { this.headers[k] = v; return this; },
    json: function (body) { this.body = body; this._done = true; return this; },
    end: function () { this._done = true; return this; },
    send: function (body) { this.body = body; this._done = true; return this; },
  };
  return res;
}

// --- Cache cleanup between tests so require() runs fresh each time ---
function freshRequire(moduleRel) {
  // moduleRel is a project-relative path. Strip leading "./" and "../" so we
  // always resolve from PROJECT_ROOT (e.g. "api/ai-edit" or "../api/ai-edit"
  // both resolve to PROJECT_ROOT/api/ai-edit.js)
  const stripped = moduleRel.replace(/^(\.\.\/)+/, "").replace(/^\.\/+/, "");
  // Add .js extension if missing
  const file = stripped.endsWith(".js") ? stripped : stripped + ".js";
  const resolved = path.join(PROJECT_ROOT, file);
  delete require.cache[resolved];
  return require(resolved);
}

// --- Per-test setup: clear caches + provide stubs ---
// We hook Module._resolveFilename so requires for "@google/genai",
// "firebase/firestore", and "firebase/app" get redirected to our stub modules
// instead of trying to load the real packages (which aren't installed locally
// during tests).
const STUB_PATHS = {
  "@google/genai": path.join(PROJECT_ROOT, "tests", "_stubs", "genai.js"),
  "firebase/firestore": path.join(PROJECT_ROOT, "tests", "_stubs", "firestore.js"),
  "firebase/app": path.join(PROJECT_ROOT, "tests", "_stubs", "firebase-app.js"),
};

// Install the hook ONCE — it stays active for all tests in this file.
const _originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (STUB_PATHS[request]) return STUB_PATHS[request];
  return _originalResolveFilename.call(this, request, parent, ...rest);
};

function setupStubs({ proUser = false, firestoreError = false, uid = "test-uid-123" } = {}) {
  // Clear ALL require cache for our project files + stub files
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(PROJECT_ROOT)) delete require.cache[k];
  }

  // Stub lib/firebase.js — mock getDb returning a mock Firestore
  const firebaseStubPath = path.join(PROJECT_ROOT, "lib", "firebase.js");
  require.cache[firebaseStubPath] = {
    id: firebaseStubPath,
    filename: firebaseStubPath,
    loaded: true,
    exports: {
      getDb: () => {
        if (firestoreError) throw new Error("Firestore unavailable");
        return { doc: () => ({}), collection: () => ({}) };
      },
    },
  };

  // Stub lib/admin-firebase.js — verifyRequestToken returns decoded token or throws
  const adminStubPath = path.join(PROJECT_ROOT, "lib", "admin-firebase.js");
  require.cache[adminStubPath] = {
    id: adminStubPath,
    filename: adminStubPath,
    loaded: true,
    exports: {
      getAdmin: () => ({}),
      verifyRequestToken: async (req) => {
        const authHeader = req.headers?.authorization || "";
        if (!authHeader.startsWith("Bearer ")) {
          const err = new Error("Missing Authorization: Bearer <token> header");
          err.status = 401;
          throw err;
        }
        if (authHeader === "Bearer invalid-token") {
          const err = new Error("Invalid or expired token");
          err.status = 401;
          throw err;
        }
        return { uid, email: "test@example.com" };
      },
    },
  };

  // Stub @google/genai via the _resolveFilename hook (set above).
  // The stub file at tests/_stubs/genai.js exports the GoogleGenAI class.
  // Tests can override its exports to control the Gemini SDK behavior.

  // Stub firebase/firestore — defaults: empty docs everywhere.
  // Tests can override getDoc to return specific data.
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath,
    filename: firestoreStubPath,
    loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => false, data: () => ({}) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  return { firebaseStubPath, adminStubPath, firestoreStubPath };
}

// --- Override global.fetch per test ---
function setGlobalFetch(handler) {
  global.fetch = handler;
  // also override AbortController if needed — leave the default Node one
}

// --- Helper to set Ashna env vars before loading modules ---
function setAshnaEnvVars({ key = "test-ashna-key", allowed = "glm-5.3-flash,claude-sonnet-5", defaultModel = "glm-5.3-flash", dailyLimit = "50" } = {}) {
  process.env.ASHNA_API_KEY = key;
  process.env.ASHNA_ALLOWED_MODELS = allowed;
  process.env.ASHNA_DEFAULT_MODEL = defaultModel;
  process.env.ASHNA_DAILY_LIMIT = dailyLimit;
}

function clearAshnaEnvVars() {
  delete process.env.ASHNA_API_KEY;
  delete process.env.ASHNA_ALLOWED_MODELS;
  delete process.env.ASHNA_DEFAULT_MODEL;
  delete process.env.ASHNA_DAILY_LIMIT;
}

// --- Mock Ashna /models response (OpenAI-compatible) ---
function mockModelsResponse(ids) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: ids.map(id => ({ id })) }),
  };
}

// --- Mock Ashna chat-completions response ---
function mockChatResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  };
}

// --- Mock fetch that handles multiple URL patterns ---
function multiRouteFetcher(routes) {
  return async (url, opts = {}) => {
    // routes: { "/api/ashna.ai/v1/api/models": (url, opts) => response, ... }
    for (const pattern of Object.keys(routes)) {
      if (url.includes(pattern)) {
        return routes[pattern](url, opts);
      }
    }
    throw new Error("Unexpected fetch: " + url);
  };
}

// =====================================================
// TEST CASES
// =====================================================

test("lib/ashna friendlyName — glm-5.3-flash → 'GLM 5.3 Flash'", () => {
  setupStubs();
  const ashna = freshRequire("../lib/ashna");
  assert.strictEqual(ashna.friendlyName("glm-5.3-flash"), "GLM 5.3 Flash");
});

test("lib/ashna friendlyName — claude-sonnet-5 → 'Claude Sonnet 5'", () => {
  setupStubs();
  const ashna = freshRequire("../lib/ashna");
  assert.strictEqual(ashna.friendlyName("claude-sonnet-5"), "Claude Sonnet 5");
});

test("lib/ashna friendlyName — gpt-4.1-mini → 'GPT 4.1 Mini'", () => {
  setupStubs();
  const ashna = freshRequire("../lib/ashna");
  assert.strictEqual(ashna.friendlyName("gpt-4.1-mini"), "GPT 4.1 Mini");
});

test("lib/ashna friendlyName — short acronym word uppercase, long word title-case", () => {
  setupStubs();
  const ashna = freshRequire("../lib/ashna");
  assert.strictEqual(ashna.friendlyName("gpt"), "GPT");
  assert.strictEqual(ashna.friendlyName("flash"), "Flash");
  assert.strictEqual(ashna.friendlyName("5"), "5");
  assert.strictEqual(ashna.friendlyName("sonnet"), "Sonnet");
});

test("lib/ashna parseAllowlist — comma-separated trim/filter", () => {
  setupStubs();
  const ashna = freshRequire("../lib/ashna");
  assert.deepStrictEqual(ashna.parseAllowlist("a, b ,c,"), ["a", "b", "c"]);
  assert.deepStrictEqual(ashna.parseAllowlist(""), []);
  assert.deepStrictEqual(ashna.parseAllowlist(null), []);
});

test("1. Gemini unchanged — provider omitted → Gemini flow path", async () => {
  // Set up: stub Firebase + Admin SDK + @google/genai (no Ashna env)
  clearAshnaEnvVars();
  process.env.GEMINI_API_KEY = "test-gemini-key";  // Gemini path requires this
  setupStubs();
  // Override @google/genai stub to return real HTML on this test.
  // We need to require() the stub first so its cache entry exists, then mutate
  // its exports to control GoogleGenAI's behavior for this test.
  const genaiStubExports = require(STUB_PATHS["@google/genai"]);
  genaiStubExports.GoogleGenAI = class {
    constructor() {}
    models = {
      generateContent: async () => ({ text: "<!DOCTYPE html><html><body>Gemini result</body></html>" }),
    };
  };

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { html: "<!DOCTYPE html><html></html>", instruction: "test", browserId: "b_test" },
    headers: {},
  });
  const res = makeMockRes();
  await handler(req, res);
  delete process.env.GEMINI_API_KEY;  // cleanup
  assert.strictEqual(res.statusCode, 200, "Gemini path should return 200");
  assert.ok(res.body.html, "Response should contain html");
  assert.ok(res.body.html.includes("Gemini result"), "Response should contain Gemini's output");
});

test("2. Pro Ashna success — valid token, Pro user, valid model → 200 with html", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });
  setupStubs({ proUser: true });
  // Mock fetch: /models returns "glm-5.3-flash" (so the catalog has it),
  // /chat/completions returns valid HTML
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash", "other-model"]),
    "/chat/completions": async () => mockChatResponse("<!DOCTYPE html><html><body>Ashna result</body></html>"),
  }));

  // Override Firebase stub to return a Pro user doc on getDoc
  const firebaseStubPath = path.join(PROJECT_ROOT, "lib", "firebase.js");
  require.cache[firebaseStubPath].exports.getDb = () => ({
    doc: () => ({}),
    collection: () => ({}),
  });
  // We need to mock the firebase/firestore `getDoc` and `doc` functions too.
  // Since ai-edit.js does: `const { doc, getDoc, setDoc } = require("firebase/firestore");`
  // We can't easily stub that without intercepting the require. Instead, let's
  // mock at a higher level — patch the firebase/firestore module too.
  let firestorePath;
  try { firestorePath = require.resolve("firebase/firestore"); } catch (e) {
    firestorePath = path.join(PROJECT_ROOT, "node_modules", "firebase", "firestore", "index.js");
  }
  // But firebase/firestore is a real package — we'll patch via the actual require.cache
  // after first require.
  require.cache[firestorePath] = {
    id: firestorePath, filename: firestorePath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200, "Should return 200 for Pro Ashna success");
  assert.ok(res.body.html, "Response should contain html");
  assert.ok(res.body.html.includes("Ashna result"), "Response should contain Ashna's output");
  // Key must NEVER appear in the response
  assert.ok(!JSON.stringify(res.body).includes("test-key"), "Response must not contain the API key");
});

test("3. Non-Pro 403 — valid token but pro !== true", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });
  setupStubs({ proUser: false });
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash"]),
    "/chat/completions": async () => { throw new Error("Should not reach chat"); },
  }));
  // Override firestore stub: user exists but pro is false
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: false }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 403, "Non-Pro user should get 403");
  assert.ok(res.body.proRequired, "Response should include proRequired flag");
});

test("4. Missing token 401 — no Authorization header", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });
  setupStubs({ proUser: true });
  setGlobalFetch(async () => { throw new Error("Should not fetch"); });

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: {},  // No Authorization header
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 401, "Missing token should return 401");
});

test("5. Missing key 503 — ASHNA_API_KEY not set", async () => {
  clearAshnaEnvVars();
  setupStubs({ proUser: true });
  // Override firestore stub: user exists with pro=true so we get past the Pro
  // check and reach the model-validation step. With no ASHNA_API_KEY, the
  // catalog is empty → validateAshnaModel returns false → 400.
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };
  // No global fetch set — call should fail before reaching fetch
  let fetchCalled = false;
  setGlobalFetch(async () => { fetchCalled = true; return mockChatResponse(""); });

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  // Missing key → catalog is empty → model validation fails → 400 (with safe message)
  assert.ok([400, 503].includes(res.statusCode), "Missing key should give 400 or 503, got " + res.statusCode);
  assert.ok(!fetchCalled, "Should not call Ashna when key is missing");
});

test("6. Invalid model 400 — model not in catalog", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });  // allowlist only has glm-5.3-flash
  setupStubs({ proUser: true });
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash"]),  // only this in live response
    "/chat/completions": async () => { throw new Error("Should not call chat"); },
  }));
  // Override firestore stub for Pro user
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  // Request a model NOT in the catalog
  const req = makeMockReq({
    body: { provider: "ashna", model: "nonexistent-model", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 400, "Invalid model should give 400");
  assert.ok(res.body.error.includes("Unknown"), "Error message should mention unknown model");
});

test("7. Model in allowlist but NOT in live /models response → rejected", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash,removed-model" });
  setupStubs({ proUser: true });
  setGlobalFetch(multiRouteFetcher({
    // Live /models only returns glm-5.3-flash (removed-model is gone)
    "/models": async () => mockModelsResponse(["glm-5.3-flash"]),
    "/chat/completions": async () => { throw new Error("Should not call chat"); },
  }));
  // Override firestore stub
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  // Request a model that's in the allowlist but not in the live response
  const req = makeMockReq({
    body: { provider: "ashna", model: "removed-model", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 400, "Model not in live /models should give 400");
});

test("8. Model not in allowlist rejected", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });  // allowlist only has glm-5.3-flash
  setupStubs({ proUser: true });
  setGlobalFetch(multiRouteFetcher({
    // Live /models has many models, but allowlist only allows glm-5.3-flash
    "/models": async () => mockModelsResponse(["glm-5.3-flash", "dangerous-model", "other"]),
    "/chat/completions": async () => { throw new Error("Should not call chat"); },
  }));
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  // Request a model in live response but NOT in allowlist
  const req = makeMockReq({
    body: { provider: "ashna", model: "dangerous-model", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 400, "Model not in allowlist should give 400");
});

test("9. Ashna 401 → mapped to 502 'AI provider error'", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });
  setupStubs({ proUser: true });
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash"]),
    "/chat/completions": async () => ({ ok: false, status: 401, json: async () => ({}) }),
  }));
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 502, "Ashna 401 should map to 502");
  assert.ok(res.body.error.includes("AI provider error"), "Error message should be safe");
  // Verify key isn't leaked in the error
  assert.ok(!JSON.stringify(res.body).includes("test-key"), "Key must not appear in error");
});

test("10. Ashna 429 → passes through as 429", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });
  setupStubs({ proUser: true });
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash"]),
    "/chat/completions": async () => ({ ok: false, status: 429, json: async () => ({}) }),
  }));
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 429, "Ashna 429 should pass through");
});

test("11. Ashna 5xx → mapped to 502", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });
  setupStubs({ proUser: true });
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash"]),
    "/chat/completions": async () => ({ ok: false, status: 503, json: async () => ({}) }),
  }));
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 502, "Ashna 5xx should map to 502");
});

test("12. Ashna timeout → 504", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });
  setupStubs({ proUser: true });
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash"]),
    // Simulate fetch being aborted (timeout). Just throw an AbortError —
    // callAshnaChat's catch block maps `err.name === "AbortError"` → 504.
    "/chat/completions": async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  }));
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 504, "Timeout should map to 504");
});

test("13. Fences stripped — ```html wrapped response gets unwrapped", () => {
  setupStubs();
  const ashna = freshRequire("../lib/ashna");
  const input = "```html\n<!DOCTYPE html><html><body>Test</body></html>\n```";
  const result = ashna.stripCodeFences(input);
  assert.strictEqual(result, "<!DOCTYPE html><html><body>Test</body></html>");
});

test("14. Incomplete HTML rejected — response without </html>", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });
  setupStubs({ proUser: true });
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash"]),
    "/chat/completions": async () => mockChatResponse("<!DOCTYPE html><html><body>Truncated"),  // no closing
  }));
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 502, "Incomplete HTML should give 502");
  assert.ok(res.body.error.includes("incomplete"), "Error message should mention incomplete");
});

test("15. Daily cap reached → 429", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash", dailyLimit: "50" });
  setupStubs({ proUser: true });
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash"]),
    "/chat/completions": async () => { throw new Error("Should not call chat"); },
  }));
  // Override firestore stub: usage doc says count=50 (at limit)
  let firestorePath;
  try { firestorePath = require.resolve("firebase/firestore"); } catch (e) {
    firestorePath = path.join(PROJECT_ROOT, "node_modules", "firebase", "firestore", "index.js");
  }
  let getDocCallCount = 0;
  require.cache[firestorePath] = {
    id: firestorePath, filename: firestorePath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => {
        getDocCallCount++;
        // First call is the user doc (Pro check), second is the usage doc
        if (getDocCallCount === 1) return { exists: () => true, data: () => ({ pro: true }) };
        return { exists: () => true, data: () => ({ count: 50 }) };  // at limit
      },
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 429, "At cap should give 429");
  assert.ok(res.body.limitReached, "Should include limitReached flag");
});

test("16. Key never appears in any response or error message", async () => {
  const SECRET_KEY = "SUPER-SECRET-ASHNA-KEY-FOR-LEAK-TEST";
  setAshnaEnvVars({ key: SECRET_KEY, allowed: "glm-5.3-flash" });
  setupStubs({ proUser: true });
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash"]),
    "/chat/completions": async () => ({ ok: false, status: 500, json: async () => ({}) }),
  }));
  const firestoreStubPath = STUB_PATHS["firebase/firestore"];
  require.cache[firestoreStubPath] = {
    id: firestoreStubPath, filename: firestoreStubPath, loaded: true,
    exports: {
      doc: () => ({}),
      getDoc: async () => ({ exists: () => true, data: () => ({ pro: true }) }),
      setDoc: async () => {},
      collection: () => ({}),
      query: () => ({}),
      where: () => ({}),
      getDocs: async () => ({ empty: true, forEach: () => {} }),
    },
  };

  const handler = freshRequire("../api/ai-edit");
  const req = makeMockReq({
    body: { provider: "ashna", model: "glm-5.3-flash", html: "<!DOCTYPE html><html></html>", instruction: "test" },
    headers: { authorization: "Bearer valid-token" },
  });
  const res = makeMockRes();
  await handler(req, res);
  const bodyStr = JSON.stringify(res.body);
  assert.ok(!bodyStr.includes(SECRET_KEY), "Key must NEVER appear in response body");
});

test("17. /api/ashna-models returns catalog with safe fields only", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash,claude-sonnet-5" });
  setupStubs();
  setGlobalFetch(multiRouteFetcher({
    "/models": async () => mockModelsResponse(["glm-5.3-flash", "claude-sonnet-5", "other-not-in-allowlist"]),
  }));
  const handler = freshRequire("../api/ashna-models");
  const req = makeMockReq({ method: "GET" });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.models), "Should return models array");
  assert.strictEqual(res.body.models.length, 2, "Should only return allowlisted models");
  assert.strictEqual(res.body.models[0].id, "glm-5.3-flash");
  assert.strictEqual(res.body.models[0].displayName, "GLM 5.3 Flash");
  assert.strictEqual(res.body.models[0].capability, "html-editing");
  assert.strictEqual(res.body.models[0].endpoint, "chat-completions");
  assert.strictEqual(res.body.defaultModel, "glm-5.3-flash");
  // Key must not appear
  assert.ok(!JSON.stringify(res.body).includes("test-key"), "Key must not appear in catalog");
});

test("18. /api/ashna-models with missing key → empty list + safe message", async () => {
  clearAshnaEnvVars();
  setupStubs();
  setGlobalFetch(async () => { throw new Error("Should not fetch"); });
  const handler = freshRequire("../api/ashna-models");
  const req = makeMockReq({ method: "GET" });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.models.length, 0);
  assert.ok(res.body.error, "Should include safe error message");
});

test("19. /api/ashna-models when Ashna is down → empty list + safe message", async () => {
  setAshnaEnvVars({ key: "test-key", allowed: "glm-5.3-flash" });
  setupStubs();
  setGlobalFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  const handler = freshRequire("../api/ashna-models");
  const req = makeMockReq({ method: "GET" });
  const res = makeMockRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.models.length, 0);
  assert.ok(res.body.error.includes("unavailable") || res.body.error.includes("AshnaAI"), "Should have safe error");
  assert.ok(!JSON.stringify(res.body).includes("test-key"), "Key must not leak in error");
});

test("20. index.html — no Ashna API key or Ashna URL hardcoded", () => {
  const fs = require("fs");
  const path = require("path");
  const html = fs.readFileSync(path.join(PROJECT_ROOT, "index.html"), "utf8");
  // Look for any string that looks like an Ashna API key (sk-... or ASHNA_API_KEY=...)
  assert.ok(!html.includes("ASHNA_API_KEY"), "index.html must not contain ASHNA_API_KEY env var reference");
  assert.ok(!html.includes("api.ashna.ai"), "index.html must not contain the Ashna API base URL");
  assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(html), "index.html must not contain anything that looks like an Ashna secret key");
  // But it should reference the /api/ashna-models endpoint (which is fine — that's the public catalog)
  assert.ok(html.includes("/api/ashna-models"), "index.html should fetch /api/ashna-models");
});

// Cleanup after all tests
test("cleanup", () => {
  clearAshnaEnvVars();
  // Clear all our project's require cache
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(PROJECT_ROOT)) delete require.cache[k];
  }
});
