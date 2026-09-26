// Smoke test for lib/clone-helpers.js
const h = require('./lib/clone-helpers.js');

const tests = [];
function eq(actual, expected, name) {
  const ok = actual === expected;
  tests.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '  (got: ' + JSON.stringify(actual) + ', expected: ' + JSON.stringify(expected) + ')'));
}

console.log('resolveUrl:');
eq(h.resolveUrl('/style.css', 'https://example.com/page/'), 'https://example.com/style.css', 'absolute path');
eq(h.resolveUrl('style.css', 'https://example.com/page/'), 'https://example.com/page/style.css', 'relative path');
eq(h.resolveUrl('https://other.com/x', 'https://example.com/'), 'https://other.com/x', 'already absolute');
eq(h.resolveUrl('data:...', 'https://example.com/'), null, 'data URI returns null');
eq(h.resolveUrl('#anchor', 'https://example.com/'), null, 'anchor returns null');
eq(h.resolveUrl('', 'https://example.com/'), null, 'empty returns null');

console.log('\nlooksLikeJsShell:');
eq(h.looksLikeJsShell('<html><body><div id="root"></div></body></html>'), true, 'empty root div = shell');
eq(h.looksLikeJsShell('<html><body><div id="app"></div></body></html>'), true, 'empty app div = shell');
// Real content = needs >500 bytes of visible text to NOT be a shell
const realContent = '<html><body><h1>Welcome to Example Site</h1><p>This is a fully rendered page with substantial visible text content that exceeds the five hundred byte threshold we use to detect JavaScript-rendered shells. The page has real paragraphs, real headings, and enough content to be considered a properly rendered static page rather than a React or Vue shell that needs client-side rendering to display anything meaningful to the user.</p><p>Additional paragraph to ensure we are well above the threshold. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p></body></html>';
eq(h.looksLikeJsShell(realContent), false, 'real content (>500 bytes) = not shell');
eq(h.looksLikeJsShell(''), false, 'empty string = not shell');
eq(h.looksLikeJsShell(null), false, 'null = not shell');

console.log('\nurlToFilePath:');
eq(h.urlToFilePath('https://example.com/'), 'index.html', 'root -> index.html');
eq(h.urlToFilePath('https://example.com/about'), 'about.html', '/about -> about.html');
eq(h.urlToFilePath('https://example.com/blog/post-1'), 'blog/post-1.html', '/blog/post-1 -> blog/post-1.html');
eq(h.urlToFilePath('https://example.com/contact/'), 'contact/index.html', '/contact/ -> contact/index.html');

console.log('\nextractSameDomainLinks:');
const html = '<a href="/about">About</a><a href="https://other.com/x">Other</a><a href="/contact">Contact</a><a href="#top">Top</a>';
const links = h.extractSameDomainLinks(html, 'https://example.com/', 10);
eq(links.length, 2, '2 same-domain links (about + contact)');
eq(links[0].url, 'https://example.com/about', 'first link is /about');
eq(links[1].url, 'https://example.com/contact', 'second link is /contact');

console.log('\nConstants:');
eq(h.MAX_JS_INLINE_BYTES, 500 * 1024, 'JS inline limit 500KB');
eq(h.MAX_ASSETS_PER_CLONE, 500, 'Max assets per clone 500');
eq(h.MAX_ASSET_SIZE_BYTES, 20 * 1024 * 1024, 'Max asset size 20MB');
eq(h.MAX_TOTAL_ASSET_BYTES, 50 * 1024 * 1024, 'Max total assets 50MB');
eq(h.MULTI_PAGE_MAX_PAGES, 10, 'Multi-page max 10');
eq(h.SMART_SCRAPE_TIMEOUT_MS, 18000, 'Smart-scrape timeout 18s');

const passed = tests.filter(t => t.ok).length;
const failed = tests.length - passed;
console.log('\n=== ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
