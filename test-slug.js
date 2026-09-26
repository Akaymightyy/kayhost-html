// Quick test for the slug validation logic (mirrors the server-side validateSlug)
// We can't easily import from main.js (it has requires), so we replicate the logic here.

const RESERVED_SLUGS = new Set([
  "admin", "api", "settings", "new", "templates", "docs", "pricing", "sites",
  "clipboard", "tools", "media", "changelog", "privacy", "terms", "site", "p",
  "signin", "signup", "save-user", "user-profile", "paystack", "clone", "deploy",
  "ashna-models", "ai-providers", "ai-edit", "serve", "og-image", "multi-deploy",
  "multi-serve", "clone-multi", "media-list", "media-delete", "api-sites",
  "api-deploy", "api-delete", "api-token-create", "api-token-list", "api-token-delete",
  "check-slug", "site-resolve", "site-update-name", "sw.js", "manifest.json",
  "favicon", "favicon.ico", "favicon.png", "icon", "icon.png", "icon-192",
  "icon-512", "apple-touch-icon", "robots", "robots.txt", "svarna-template",
  "index.html", "_next", "auth", "upgrade", "pro", "billing", "account",
]);

function validateSlug(slug) {
  if (!slug) return { ok: false, error: "Custom name is required" };
  if (typeof slug !== "string") return { ok: false, error: "Invalid custom name" };
  const lower = slug.toLowerCase().trim();
  if (lower.length < 3) return { ok: false, error: "Custom name must be at least 3 characters" };
  if (lower.length > 30) return { ok: false, error: "Custom name must be 30 characters or fewer" };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(lower)) {
    return { ok: false, error: "Custom name can only contain lowercase letters, numbers, and hyphens (no leading/trailing hyphens)" };
  }
  if (RESERVED_SLUGS.has(lower)) {
    return { ok: false, error: '"' + lower + '" is a reserved word' };
  }
  return { ok: true, normalized: lower };
}

const tests = [
  // Valid slugs
  ["akaytech", true, "valid slug"],
  ["my-site", true, "hyphen in middle"],
  ["site123", true, "letters + numbers"],
  ["abc", true, "minimum 3 chars"],
  ["a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5", true, "exactly 30 chars"],
  ["a-b-c", true, "multiple hyphens"],

  // Invalid slugs
  ["ab", false, "too short (2 chars)"],
  ["a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7", false, "too long (31 chars)"],
  ["-akay", false, "leading hyphen"],
  ["akay-", false, "trailing hyphen"],
  ["AkayTech", true, "uppercase gets normalized to lowercase"],
  ["akay_tech", false, "underscore not allowed"],
  ["akay.tech", false, "dot not allowed"],
  ["akay tech", false, "space not allowed"],
  ["", false, "empty"],
  [null, false, "null"],

  // Reserved words
  ["admin", false, "reserved: admin"],
  ["api", false, "reserved: api"],
  ["settings", false, "reserved: settings"],
  ["new", false, "reserved: new"],
  ["templates", false, "reserved: templates"],
  ["site", false, "reserved: site"],
  ["p", false, "reserved: p (but also too short)"],
  ["media", false, "reserved: media"],
  ["pricing", false, "reserved: pricing"],
];

let passed = 0, failed = 0;
for (const [input, expectedOk, description] of tests) {
  const result = validateSlug(input);
  const actualOk = result.ok;
  if (actualOk === expectedOk) {
    passed++;
    console.log("  PASS  " + description + " (" + JSON.stringify(input) + " -> " + (result.ok ? "OK" : "rejected: " + result.error) + ")");
  } else {
    failed++;
    console.log("  FAIL  " + description + " (" + JSON.stringify(input) + " -> expected " + expectedOk + " but got " + actualOk + ": " + (result.error || "OK") + ")");
  }
}
console.log("\n=== " + passed + " passed, " + failed + " failed ===");
process.exit(failed > 0 ? 1 : 0);
