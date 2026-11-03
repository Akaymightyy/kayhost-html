// /middleware.js — Vercel Edge Middleware that runs BEFORE every request.
//
// Two jobs:
//   1. Block known scraper/bot User-Agents (wget, curl, httrack, scrapy, etc.)
//      so a lazy `wget --mirror https://kayhosthtml.zone.id/` returns 403.
//   2. Detect custom-domain requests (Host header != kayhosthtml.zone.id)
//      and rewrite them to /api/main?route=custom-domain-serve so we can
//      look up the site by host and serve its HTML.
//
// Custom domains are stored in Firestore collection "customDomains".
// When a request comes in with Host: mybrand.com, we rewrite the URL to
// /api/main?route=custom-domain-serve&host=mybrand.com&originalPath=/...

const MAIN_HOST = "kayhosthtml.zone.id";

export default function middleware(req) {
  const ua = (req.headers.get("user-agent") || "").toLowerCase();

  // 1. Block known scraping tool User-Agents
  const scraperPatterns = [
    "wget", "curl", "httrack", "scrapy",
    "python-requests", "python-httpx", "python-urllib",
    "httpclient", "mechanize", "node-fetch", "got/", "axios/",
    "go-http-client", "okhttp", "spider", "crawler",
    "archive.org", "ahrefsbot", "semrush", "bytespider",
  ];
  for (const pattern of scraperPatterns) {
    if (ua.includes(pattern)) {
      return new Response(
        JSON.stringify({ error: "Automated access forbidden. Use a real browser." }) + "\n",
        { status: 403, headers: { "Content-Type": "application/json", "Retry-After": "3600" } }
      );
    }
  }

  // 2. Block empty/too-short User-Agent
  if (!ua || ua.trim().length < 20) {
    return new Response("Forbidden: missing or too-short User-Agent.\n", {
      status: 403, headers: { "Content-Type": "text/plain" },
    });
  }

  // 3. Detect custom domain requests
  const host = (req.headers.get("host") || "").toLowerCase();
  const url = new URL(req.url);

  // Only handle "real" custom domains — not the main host, not localhost, not Vercel preview URLs
  if (host && host !== MAIN_HOST && !host.endsWith(".vercel.app") && !host.endsWith("." + MAIN_HOST) && host !== "localhost") {
    // Rewrite to the custom-domain-serve route. The api/main.js handler will:
    //   1. Look up the host in Firestore customDomains collection
    //   2. If found and verified → serve the linked site's HTML (or multi-page asset)
    //   3. If not found → return 404
    const newPath = "/api/main?route=custom-domain-serve&host=" + encodeURIComponent(host) + "&originalPath=" + encodeURIComponent(url.pathname + url.search);
    return Response.redirect(new URL(newPath, url.origin), 307);
  }

  // 4. Block hot-linking of the main SPA shell from other domains
  //    (but allow custom domains — they're legit)
  const referer = req.headers.get("referer") || "";
  if (referer && host === MAIN_HOST) {
    try {
      const refOrigin = new URL(referer).origin;
      const myOrigin = url.origin;
      if (refOrigin !== myOrigin) {
        return new Response("Forbidden: cross-origin hot-linking blocked.\n", {
          status: 403, headers: { "Content-Type": "text/plain" },
        });
      }
    } catch (e) { /* malformed referer — allow through */ }
  }

  // All good — let the request through
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt).*)",
  ],
};
