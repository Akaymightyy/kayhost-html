// Quick sanity test for lib/multipage.js
const m = require('./lib/multipage.js');

const tests = [];
function eq(actual, expected, name) {
  const ok = actual === expected;
  tests.push({ name, ok, actual, expected });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '  (got: ' + JSON.stringify(actual) + ', expected: ' + JSON.stringify(expected) + ')'));
}

console.log('filePathToUrlPath:');
eq(m.filePathToUrlPath('index.html'), '/', 'index.html -> /');
eq(m.filePathToUrlPath('about.html'), '/about', 'about.html -> /about');
eq(m.filePathToUrlPath('contact.html'), '/contact', 'contact.html -> /contact');
eq(m.filePathToUrlPath('blog/post-1.html'), '/blog/post-1', 'blog/post-1.html -> /blog/post-1');
eq(m.filePathToUrlPath('blog/index.html'), '/blog', 'blog/index.html -> /blog');
eq(m.filePathToUrlPath('css/style.css'), '/css/style.css', 'css/style.css -> /css/style.css (keeps extension)');
eq(m.filePathToUrlPath('js/main.js'), '/js/main.js', 'js/main.js -> /js/main.js');
eq(m.filePathToUrlPath('images/logo.png'), '/images/logo.png', 'images/logo.png -> /images/logo.png');

console.log('\nbuildPathMap:');
const files = {
  'index.html': '<html>',
  'about.html': '<html>',
  'contact.html': '<html>',
  'blog/post-1.html': '<html>',
  'css/style.css': 'body{}',
  'js/main.js': 'console.log(1)',
};
const pm = m.buildPathMap(files);
eq(pm['/'], 'index.html', 'pathMap[/] = index.html');
eq(pm['/about'], 'about.html', 'pathMap[/about] = about.html');
eq(pm['/contact'], 'contact.html', 'pathMap[/contact] = contact.html');
eq(pm['/blog/post-1'], 'blog/post-1.html', 'pathMap[/blog/post-1] = blog/post-1.html');
eq(pm['/css/style.css'], 'css/style.css', 'pathMap[/css/style.css] = css/style.css');
eq(pm['/js/main.js'], 'js/main.js', 'pathMap[/js/main.js] = js/main.js');

console.log('\nresolvePath:');
eq(m.resolvePath('/', pm), 'index.html', 'GET / -> index.html');
eq(m.resolvePath('/about', pm), 'about.html', 'GET /about -> about.html');
eq(m.resolvePath('/about/', pm), 'about.html', 'GET /about/ -> about.html (trailing slash)');
eq(m.resolvePath('/blog/post-1', pm), 'blog/post-1.html', 'GET /blog/post-1 -> blog/post-1.html');
eq(m.resolvePath('/css/style.css', pm), 'css/style.css', 'GET /css/style.css -> css/style.css');
eq(m.resolvePath('/unknown', pm), null, 'GET /unknown -> null');

console.log('\nisMultiPageProject:');
eq(m.isMultiPageProject({ 'index.html': 'x', 'about.html': 'y' }), true, '2 HTML files = multi-page');
eq(m.isMultiPageProject({ 'index.html': 'x', 'style.css': 'y' }), false, '1 HTML + 1 CSS = NOT multi-page');
eq(m.isMultiPageProject({ 'index.html': 'x' }), false, '1 HTML only = NOT multi-page');
eq(m.isMultiPageProject({}), false, 'empty = NOT multi-page');
eq(m.isMultiPageProject(null), false, 'null = NOT multi-page');

console.log('\nvalidateFiles:');
eq(m.validateFiles({ 'index.html': 'x' }).ok, true, '1 HTML = valid');
eq(m.validateFiles({ 'index.html': 'x', 'about.html': 'y' }).ok, true, '2 HTML = valid');
eq(m.validateFiles({ 'style.css': 'x' }).ok, false, 'no HTML = invalid');
eq(m.validateFiles({}).ok, false, 'empty = invalid');
eq(m.validateFiles({ '../etc/passwd': 'x' }).ok, false, 'path traversal = invalid');
eq(m.validateFiles({ '/etc/passwd': 'x' }).ok, false, 'absolute path = invalid');

console.log('\ngetMimeType:');
eq(m.getMimeType('index.html'), 'text/html; charset=utf-8', 'html mime');
eq(m.getMimeType('style.css'), 'text/css; charset=utf-8', 'css mime');
eq(m.getMimeType('main.js'), 'application/javascript; charset=utf-8', 'js mime');
eq(m.getMimeType('logo.png'), 'image/png', 'png mime');
eq(m.getMimeType('unknown.xyz'), 'application/octet-stream', 'unknown mime');

const passed = tests.filter(t => t.ok).length;
const failed = tests.length - passed;
console.log('\n=== ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
