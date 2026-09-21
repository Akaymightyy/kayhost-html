// /middleware.js — Vercel Edge Middleware that runs BEFORE every request.
// Blocks known scraper/bot User-Agents (wget, curl, httrack, scrapy, python-requests, etc.)
// so a lazy `wget --mirror https://kayhosthtml.zone.id/` returns 403 immediately,
// without serving the SPA shell or any static asset.
//
// This is what would have stopped the "DevzConn" WhatsApp group from mirroring
// the index.html with `wget --mirror` and sharing it in the chat.
//
// It's not bulletproof (a determined scraper can spoof User-Agent) — but it stops
// the lazy/default behavior of every common scraping tool.

export default function middleware(req) {
  const ua = (req.headers.get("user-agent") || "").toLowerCase();

  // 1. Block known scraping tool User-Agents
  const scraperPatterns = [
    "wget",            // GNU wget (the one used in the attack)
    "curl",            // command-line curl
    "httrack",         // HTTrack Website Copier
    "scrapy",          // Scrapy Python framework
    "python-requests", // python-requests library
    "python-httpx",    // httpx library
    "python-urllib",   // urllib
    "httpclient",      // Java HttpClient
    "mechanize",       // Perl/Python Mechanize
    "node-fetch",      // node-fetch (when used outside browsers)
    "got/",            // got Node.js HTTP client
    "axios/",          // axios Node.js HTTP client
    "go-http-client",  // Go net/http
    "okhttp",          // OkHttp (Android)
    "spider",          // generic spiders
    "crawler",         // generic crawlers
    "archive.org",     // Internet Archive
    "ahrefsbot",       // Ahrefs SEO crawler
    "semrush",         // Semrush
    "bytespider",      // TikTok crawler
  ];

  for (const pattern of scraperPatterns) {
    if (ua.includes(pattern)) {
      return new Response(
        JSON.stringify({ error: "Automated access forbidden. Use a real browser." }) + "\n",
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "3600",
          },
        }
      );
    }
  }

  // 2. Block empty User-Agent (real browsers always send one)
  if (!ua || ua.trim().length < 10) {
    return new Response("Forbidden: missing or too-short User-Agent.\n", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // 3. Require a minimum User-Agent length to filter basic scripted requests
  //    (Real browsers send 50+ char UAs; bot scripts often send very short ones)
  if (ua.length < 20) {
    return new Response("Forbidden: suspicious User-Agent.\n", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // 4. Block hot-linking of the main SPA shell from other domains
  //    (someone framing kayhosthtml.zone.id in an iframe on another site)
  const referer = req.headers.get("referer") || "";
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      const myOrigin = new URL(req.url).origin;
      if (refOrigin !== myOrigin) {
        return new Response("Forbidden: cross-origin hot-linking blocked.\n", {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        });
      }
    } catch (e) { /* malformed referer — allow through */ }
  }

  // All good — let the request through
  // (security headers are added via vercel.json "headers" block)
}

// Run on all paths except Next.js internals and vercel-static asset prefixes
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt).*)",
  ],
};
