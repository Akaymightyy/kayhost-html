// tests/_stubs/genai.js — stub for @google/genai SDK used during tests.
// The real package isn't installed in the test environment, so the
// Module._resolveFilename hook in ashna.test.js redirects require("@google/genai")
// to this file. Tests can override this.exports.GoogleGenAI to control behavior.

class GoogleGenAI {
  constructor() {}
  models = {
    generateContent: async () => {
      throw new Error("Gemini should not be called in Ashna tests");
    },
  };
}

module.exports = { GoogleGenAI };
