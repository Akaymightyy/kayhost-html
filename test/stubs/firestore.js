// tests/_stubs/firestore.js — stub for firebase/firestore used during tests.
// Module._resolveFilename in ashna.test.js redirects require("firebase/firestore")
// here. Tests typically override getDoc to return specific docs.

module.exports = {
  doc: () => ({}),
  getDoc: async () => ({ exists: () => false, data: () => ({}) }),
  setDoc: async () => {},
  collection: () => ({}),
  query: () => ({}),
  where: () => ({}),
  getDocs: async () => ({ empty: true, forEach: () => {} }),
};
