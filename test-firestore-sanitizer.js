// Test the Firestore sanitizer — confirms that dotted keys like "css/style.css"
// are safely serialized to JSON strings and round-trip correctly.

// Replicate the helpers (can't easily import from main.js due to requires)
function sanitizeProjectForFirestore(files, pathMap) {
  function scrubUndefined(obj) {
    if (obj === null || obj === undefined) return null;
    if (Array.isArray(obj)) return obj.map(scrubUndefined);
    if (typeof obj === "object") {
      const out = {};
      for (const k of Object.keys(obj)) {
        out[k] = scrubUndefined(obj[k]);
      }
      return out;
    }
    return obj;
  }
  const cleanFiles = scrubUndefined(files || {});
  const cleanPathMap = scrubUndefined(pathMap || {});
  return {
    filesJson: JSON.stringify(cleanFiles),
    pathMapJson: JSON.stringify(cleanPathMap),
  };
}

function deserializeProjectFiles(docData) {
  let files = {};
  let pathMap = {};
  if (docData.filesJson && typeof docData.filesJson === "string") {
    try { files = JSON.parse(docData.filesJson); } catch (e) { files = {}; }
  } else if (docData.files && typeof docData.files === "object") {
    files = docData.files;
  }
  if (docData.pathMapJson && typeof docData.pathMapJson === "string") {
    try { pathMap = JSON.parse(docData.pathMapJson); } catch (e) { pathMap = {}; }
  } else if (docData.pathMap && typeof docData.pathMap === "object") {
    pathMap = docData.pathMap;
  }
  return { files, pathMap };
}

const tests = [];
function eq(actual, expected, name) {
  const ok = actual === expected;
  tests.push({ name, ok });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : "  (got: " + JSON.stringify(actual).slice(0, 80) + ", expected: " + JSON.stringify(expected).slice(0, 80) + ")"));
}

console.log("Test 1: Files with dotted keys round-trip correctly");
const files1 = {
  "index.html": "<html>home</html>",
  "about.html": "<html>about</html>",
  "css/style.css": "body { color: red; }",  // <-- the key that broke Firestore
  "js/main.js": "console.log(1);",
  "blog/post-1.html": "<html>post</html>",
};
const pathMap1 = {
  "/": "index.html",
  "/about": "about.html",
  "/css/style.css": "css/style.css",  // <-- also has dots
  "/blog/post-1": "blog/post-1.html",
};
const sanitized1 = sanitizeProjectForFirestore(files1, pathMap1);
console.log("  sanitized fields:", Object.keys(sanitized1));
eq(typeof sanitized1.filesJson, "string", "filesJson is a string");
eq(typeof sanitized1.pathMapJson, "string", "pathMapJson is a string");
eq(sanitized1.filesJson === undefined, false, "filesJson is not undefined");
eq(sanitized1.pathMapJson === undefined, false, "pathMapJson is not undefined");

// Simulate what Firestore would store (just the two string fields, no native maps)
const firestoreDoc1 = {
  id: "abc123",
  title: "Test",
  filesJson: sanitized1.filesJson,
  pathMapJson: sanitized1.pathMapJson,
};

// Deserialize
const { files: recovered1, pathMap: recoveredPathMap1 } = deserializeProjectFiles(firestoreDoc1);
eq(recovered1["css/style.css"], "body { color: red; }", "dotted file key recovers");
eq(recovered1["blog/post-1.html"], "<html>post</html>", "nested folder key recovers");
eq(recovered1["index.html"], "<html>home</html>", "plain key recovers");
eq(recoveredPathMap1["/css/style.css"], "css/style.css", "dotted pathMap key recovers");
eq(recoveredPathMap1["/"], "index.html", "root pathMap key recovers");

console.log("\nTest 2: undefined values are scrubbed");
const files2 = {
  "index.html": "<html></html>",
  "maybe-empty.js": undefined,  // <-- Firestore rejects this
};
const sanitized2 = sanitizeProjectForFirestore(files2, {});
eq(sanitized2.filesJson.includes("undefined"), false, "no literal 'undefined' in JSON");
const recovered2 = JSON.parse(sanitized2.filesJson);
eq(recovered2["maybe-empty.js"], null, "undefined became null");

console.log("\nTest 3: Backwards compat with old native-map format");
const oldDoc = {
  id: "old123",
  files: { "index.html": "<html>old</html>" },  // old format: native map
  pathMap: { "/": "index.html" },
};
const { files: oldFiles, pathMap: oldPathMap } = deserializeProjectFiles(oldDoc);
eq(oldFiles["index.html"], "<html>old</html>", "old native-map files still readable");
eq(oldPathMap["/"], "index.html", "old native-map pathMap still readable");

console.log("\nTest 4: Empty objects");
const sanitized4 = sanitizeProjectForFirestore({}, {});
eq(sanitized4.filesJson, "{}", "empty files -> {}");
eq(sanitized4.pathMapJson, "{}", "empty pathMap -> {}");

const passed = tests.filter(t => t.ok).length;
const failed = tests.length - passed;
console.log("\n=== " + passed + " passed, " + failed + " failed ===");
process.exit(failed > 0 ? 1 : 0);
