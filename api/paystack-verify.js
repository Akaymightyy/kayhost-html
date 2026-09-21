// /api/paystack-verify.js — Verifies a Paystack payment by its reference
// and marks the signed-in user as Pro in Firestore if payment was successful.
//
// SECURITY:
//   - The Paystack SECRET key is read from the PAYSTACK_SECRET_KEY Vercel env var.
//     NEVER hardcode it in the source. If you ever see "sk_live_..." in this file,
//     someone made a mistake — rotate the key immediately.
//   - We verify the payment SERVER-SIDE by calling Paystack's verify endpoint
//     (https://api.paystack.co/transaction/verify/:reference) with the secret key.
//     The client can't fake this — only Paystack knows the real transaction status.
//   - We also verify the email in the payment matches the signed-in user's email
//     (so user A can't pay with user B's email and unlock Pro for them).

const { getDb } = require("./_firebase");
const { doc, getDoc, setDoc, updateDoc } = require("firebase/firestore");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PRO_PRICE_KOBO = 1_000_000 * 100;  // ₦10,000 in kobo (Paystack uses kobo)
const ADMIN_EMAILS = ["awwalabdul891@gmail.com", "kayhost@admin.com"].map(e => e.toLowerCase());

// Block scraper/bot User-Agents at the function level.
function isScraperUa(ua) {
  if (!ua || ua.length < 20) return true;
  const lower = ua.toLowerCase();
  const patterns = ["wget", "curl", "httrack", "scrapy", "python-requests", "python-httpx",
    "python-urllib", "httpclient", "mechanize", "node-fetch", "got/", "axios/",
    "go-http-client", "okhttp", "spider", "crawler", "archive.org", "ahrefsbot",
    "semrush", "bytespider"];
  return patterns.some(p => lower.includes(p));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  // Block scrapers
  if (isScraperUa(req.headers["user-agent"] || "")) {
    return res.status(403).json({ error: "Automated access forbidden." });
  }

  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "Payment verification not configured. Set PAYSTACK_SECRET_KEY env var." });
    }

    const { reference, email: userEmail } = req.body || {};
    if (!reference) {
      return res.status(400).json({ error: "Payment reference required." });
    }

    // 1. Verify the payment with Paystack
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Cache-Control": "no-cache",
        },
      }
    );

    if (!verifyRes.ok) {
      console.error("[paystack-verify] Paystack returned HTTP", verifyRes.status);
      return res.status(502).json({ error: "Couldn't verify payment with Paystack. Please try again or contact support." });
    }

    const verifyData = await verifyRes.json();
    if (!verifyData.status) {
      // Paystack returned an error response
      return res.status(400).json({ error: verifyData.message || "Payment verification failed." });
    }

    const tx = verifyData.data || {};
    // 2. Check payment status
    if (tx.status !== "success") {
      return res.status(400).json({
        error: "Payment was not completed successfully. Status: " + (tx.status || "unknown"),
        status: tx.status,
      });
    }

    // 3. Check the amount paid (in kobo) — protect against someone paying ₦1 instead of ₦10,000
    //    The amount is in kobo (₦1 = 100 kobo), so ₦10,000 = 1,000,000 kobo
    const expectedKobo = 1_000_000;
    const actualKobo = Number(tx.amount) || 0;
    // Allow a small tolerance for currency conversion fees (₦5)
    if (actualKobo < expectedKobo - 500) {
      console.warn("[paystack-verify] Amount mismatch — expected", expectedKobo, "got", actualKobo);
      return res.status(400).json({
        error: `Payment amount incorrect. Expected ₦10,000, got ₦${(actualKobo / 100).toLocaleString()}. Contact support.`,
      });
    }

    // 4. Check that the email in the payment matches the signed-in user's email
    //    (Prevents user A from paying with user B's email and unlocking Pro for B)
    const txEmail = (tx.customer && tx.customer.email || "").toLowerCase();
    const expectedEmail = (userEmail || "").toLowerCase();
    if (!txEmail || !expectedEmail || txEmail !== expectedEmail) {
      console.warn("[paystack-verify] Email mismatch — tx:", txEmail, "expected:", expectedEmail);
      return res.status(400).json({
        error: "Payment email doesn't match your account email. Please pay with the same email you signed in with.",
      });
    }

    // 5. Find the user in Firestore by email, mark them as Pro
    const db = getDb();

    // Try to find the user doc by querying the email
    // (handles the merged-duplicate case — see save-user.js)
    const { query, where, getDocs, collection } = require("firebase/firestore");
    const emailQuery = query(collection(db, "users"), where("email", "==", txEmail));
    const emailSnap = await getDocs(emailQuery);

    if (emailSnap.empty) {
      return res.status(404).json({ error: "Account not found. Please sign in at least once before paying." });
    }

    // Mark ALL matching docs as Pro (in case of legacy duplicates)
    const batch = [];
    emailSnap.forEach(d => batch.push(d.id));
    const now = Date.now();
    for (const uid of batch) {
      try {
        await updateDoc(doc(db, "users", uid), {
          pro: true,
          proSetAt: now,
          proSetBy: "paystack",
          proPaymentRef: reference,
          proPaymentAmount: actualKobo,
          proPaymentDate: now,
        });
      } catch (e) { /* skip */ }
    }

    // 6. Log the payment in a `payments` collection for audit
    try {
      await setDoc(doc(db, "payments", reference), {
        reference,
        email: txEmail,
        amount: actualKobo,
        currency: tx.currency || "NGN",
        status: tx.status,
        channel: tx.channel,
        paidAt: now,
        customerCode: tx.customer && tx.customer.customer_code,
        proUidsMarked: batch,
      });
    } catch (e) { /* audit log — failure non-critical */ }

    return res.status(200).json({
      success: true,
      message: "Payment verified. Your account is now Pro! Refresh the page to access Pro features.",
      markedUids: batch.length,
    });
  } catch (err) {
    console.error("[paystack-verify] Error:", err);
    return res.status(500).json({ error: "Payment verification failed: " + (err.message || "unknown error") });
  }
};
