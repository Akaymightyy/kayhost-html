// /api/save-user.js — Saves user profile to Firestore after Google/GitHub sign-in
// Called from the client after Firebase Auth succeeds (popup or redirect)
// DEDUPE: checks both UID AND email to prevent duplicates when the same email
// is linked to multiple auth providers (e.g. Google UID + password UID).
const { getDb } = require("./_firebase");
const { doc, setDoc, getDoc, query, where, getDocs, collection, deleteDoc } = require("firebase/firestore");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { uid, email, displayName, photoURL, provider } = req.body || {};
    if (!uid) return res.status(400).json({ error: "uid required" });

    const db = getDb();
    const normalizedEmail = (email || "").trim().toLowerCase();
    const now = Date.now();

    // Step 1: If a doc with this UID already exists, update it (don't overwrite createdAt/pro flags).
    const existingByUid = await getDoc(doc(db, "users", uid));
    if (existingByUid.exists()) {
      // Touch up provider/photoURL/displayName without wiping existing flags
      const data = existingByUid.data() || {};
      const patch = {};
      if (displayName && !data.displayName) patch.displayName = displayName;
      if (photoURL && !data.photoURL) patch.photoURL = photoURL;
      if (provider && !data.provider) patch.provider = provider;
      if (normalizedEmail && !data.email) patch.email = normalizedEmail;
      if (Object.keys(patch).length) {
        await setDoc(doc(db, "users", uid), { ...data, ...patch }, { merge: true });
      }
      return res.status(200).json({ success: true, mode: "updated-existing-uid" });
    }

    // Step 2: No doc with this UID — but maybe a doc with the same email exists (created via a different provider).
    // This is the case that causes duplicates. We MERGE instead of creating a new doc.
    if (normalizedEmail) {
      const emailQuery = query(collection(db, "users"), where("email", "==", normalizedEmail));
      const emailSnap = await getDocs(emailQuery);
      if (!emailSnap.empty) {
        // Found existing doc(s) with same email — pick the oldest as canonical, delete the rest, repoint UID
        const matches = [];
        emailSnap.forEach(d => matches.push({ id: d.id, data: d.data() }));
        matches.sort((a, b) => (a.data.createdAt || 0) - (b.data.createdAt || 0));
        const canonical = matches[0];

        // Merged profile: union of all fields, latest wins for trivial fields
        const merged = {
          uid: canonical.data.uid || uid,
          email: normalizedEmail,
          displayName: displayName || canonical.data.displayName || canonical.data.email || "",
          photoURL: photoURL || canonical.data.photoURL || "",
          provider: provider || canonical.data.provider || "unknown",
          // Merge flags — if ANY doc says pro/suspended/admin, keep it true
          pro: matches.some(m => m.data.pro) || canonical.data.pro || false,
          suspended: matches.some(m => m.data.suspended) || canonical.data.suspended || false,
          createdAt: canonical.data.createdAt || now,
          lastMergedAt: now,
        };

        // Write merged profile under the NEW uid (so this auth account can find it)
        await setDoc(doc(db, "users", uid), merged);

        // Delete old duplicate docs (under their old UIDs) — but only if different from new uid
        for (const m of matches) {
          if (m.id !== uid) {
            try { await deleteDoc(doc(db, "users", m.id)); } catch (e) {}
          }
        }

        return res.status(200).json({ success: true, mode: "merged-by-email", removedDuplicates: matches.length });
      }
    }

    // Step 3: Brand new user — create normally
    await setDoc(doc(db, "users", uid), {
      uid,
      email: normalizedEmail,
      displayName: displayName || "",
      photoURL: photoURL || "",
      provider: provider || "unknown",
      createdAt: now,
      pro: false,
      suspended: false,
    });
    return res.status(200).json({ success: true, mode: "created-new" });
  } catch (err) {
    console.error("[save-user] Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
