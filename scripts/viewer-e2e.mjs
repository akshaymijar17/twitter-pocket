// UI check of the viewer with Firebase replaced by in-memory fakes
// (tests/viewer-fakes). Run: node scripts/viewer-e2e.mjs
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const dir = mkdtempSync(join(tmpdir(), 'xbs-viewer-'));
const fake = resolve('tests/viewer-fakes/firebase.js');
await esbuild.build({
  entryPoints: ['viewer/src/app.js'],
  outfile: join(dir, 'app.js'),
  bundle: true,
  format: 'esm',
  plugins: [{ name: 'fake-firebase', setup: (b) => b.onResolve({ filter: /^firebase\// }, () => ({ path: fake })) }],
});

const post = (id, text, extra = {}) => ({ id, text, created_at: '2025-10-01T10:00:00.000Z', media: [], quoted: null, unavailable: false, ...extra });
const docs = {
  t1: {
    id: 't1', type: 'thread', thread_complete: true, author_name: 'Naval', author_handle: 'naval', url: 'https://x.com/naval/status/t1',
    created_at: '2025-10-01T10:00:00.000Z', bookmarked_post_id: 'p2', bookmarked_at: '2026-01-02T00:00:00.000Z', post_count: 3,
    posts: [post('p1', 'How to get rich'), post('p2', 'Seek wealth <b>not</b> status', { quoted: { id: 'q', author_handle: 'bob', text: 'quoted text', url: 'https://x.com/bob/status/q' } }), post('p3', 'Specific knowledge is found by pursuing your genuine curiosity', { media: ['https://pbs.twimg.com/media/A.jpg'] })],
    preview: 'How to get rich', search_text: 'how to get rich\nseek wealth <b>not</b> status bob quoted text\nspecific knowledge is found by pursuing your genuine curiosity\nnaval @naval naval',
    search_tokens: ['how', 'to', 'get', 'rich', 'seek', 'wealth', 'specific', 'knowledge', 'curiosity', 'naval'], status: 'unread', favorite: false, tags: [],
  },
  p9: {
    id: 'p9', type: 'thread', thread_complete: false, author_name: 'Alice', author_handle: 'alice', url: 'https://x.com/alice/status/p9',
    created_at: '2025-09-01T10:00:00.000Z', bookmarked_post_id: 'p9', bookmarked_at: '2026-01-01T00:00:00.000Z', post_count: 1,
    posts: [post('p9', '2/ middle of a thread')], preview: '2/ middle of a thread', search_text: '2/ middle of a thread\nalice @alice alice',
    search_tokens: ['middle', 'of', 'thread', 'alice'], status: 'read', favorite: true, tags: ['ideas'],
  },
};
writeFileSync(join(dir, 'config.js'), `window.FIREBASE_CONFIG = {}; window.__FAKE_DOCS__ = ${JSON.stringify(docs)};`);
writeFileSync(join(dir, 'index.html'), readFileSync('viewer/index.html', 'utf8').replace(/<link[^>]+fonts[^>]+>/g, ''));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('http://viewer.test/**', (r) => {
  const f = new URL(r.request().url()).pathname.slice(1) || 'index.html';
  r.fulfill({ body: readFileSync(join(dir, f)), contentType: f.endsWith('.js') ? 'text/javascript' : 'text/html' });
});
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const rows = () => page.locator('#list .row .preview').allTextContents();

await page.goto('http://viewer.test/');
await page.waitForSelector('#list .row');
check('unread list shows unread items only', JSON.stringify(await rows()) === JSON.stringify(['How to get rich']));
await page.click('#status [data-status=all]');
check('all: sorted by date bookmarked', JSON.stringify(await rows()) === JSON.stringify(['How to get rich', '2/ middle of a thread']));
await page.check('#incomplete');
check('incomplete-threads filter', JSON.stringify(await rows()) === JSON.stringify(['2/ middle of a thread']));
await page.uncheck('#incomplete');
await page.selectOption('#author', 'alice');
check('author filter', (await rows()).length === 1);
await page.selectOption('#author', '');
await page.selectOption('#type', 'thread');
check('type filter', (await rows()).length === 2);
await page.selectOption('#type', 'all');

await page.fill('#search', 'genuine curio');
check('substring search finds a word from the middle of a thread', JSON.stringify(await rows()) === JSON.stringify(['How to get rich']));
await page.fill('#search', 'curiosity');
await page.waitForTimeout(500);
check('single word also queries search_tokens with array-contains', (await page.evaluate(() => window.__serverQueries__)) >= 1);
await page.fill('#search', '');

await page.locator('#list .row .main').first().click();
await page.waitForSelector('#item-view .post');
check('reading view numbers posts', JSON.stringify(await page.locator('.post .num').allTextContents()) === JSON.stringify(['1/3', '2/3 · bookmarked', '3/3']));
check('post text is not parsed as HTML', (await page.locator('.post .text').nth(1).textContent()).includes('<b>not</b>'));
check('quoted post inline', (await page.locator('.post blockquote').textContent()).includes('quoted text'));
check('media links', (await page.locator('.post .media a').getAttribute('href')) === 'https://pbs.twimg.com/media/A.jpg');
await page.click('#item-view .folder-toggle button:text("archived")');
await page.click('#item-view .star');
await page.fill('#item-view .tags', 'Wealth, ideas');
await page.press('#item-view .tags', 'Enter');
await page.waitForTimeout(100);
const writes = await page.evaluate(() => window.__writes__);
check('actions write only viewer fields', writes.every((w) => Object.keys(w.fields).every((k) => ['status', 'favorite', 'tags'].includes(k))) && writes.length === 3, JSON.stringify(writes));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#item-view button:text("export .md")')]);
check('markdown export', dl.suggestedFilename() === '2025-10-01-naval-t1.md');
await page.click('#item-view .back');
const [zip] = await Promise.all([page.waitForEvent('download'), page.click('#export-all')]);
check('zip export', /^x-bookmarks-\d{4}-\d\d-\d\d\.zip$/.test(zip.suggestedFilename()));
await page.setViewportSize({ width: 375, height: 800 });
check('no horizontal scroll on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= 375));
check('no stray null text', !(await page.locator('body').textContent()).includes('null'));
check('no page errors', errors.length === 0, errors.join('; '));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
