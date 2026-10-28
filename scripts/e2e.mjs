// End-to-end check of the built extension in Chromium against a fake x.com
// served from the test fixtures (no network, no X account). Firestore is
// unreachable here, so saves stay in the local queue, which is what we inspect.
// Run: npm run build && node scripts/e2e.mjs
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Playwright is not a project dependency; use whatever install is on NODE_PATH.
const { chromium } = createRequire(import.meta.url)('playwright');

const dist = resolve('dist');
const fx = (n) => readFileSync(join('tests/fixtures', n), 'utf8');
const page = (script) => `<!doctype html><html><body><main id="m" style="height:3000px">fake x.com</main><script>${script}</script></body></html>`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xbs-')), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

await ctx.route('https://x.com/**', (route) => {
  const url = route.request().url();
  if (url.includes('/graphql/')) {
    const op = /graphql\/[^/]+\/(\w+)/.exec(url)[1];
    const v = new URL(url).searchParams.get('v');
    const body = op === 'Bookmarks' ? fx(v === '2' ? 'bookmarks-empty.json' : 'bookmarks-page1.json')
      : fx(v === '2' ? 'tweetdetail-showmore.json' : 'tweetdetail-thread.json');
    return route.fulfill({ contentType: 'application/json', body });
  }
  if (url.includes('/i/bookmarks')) {
    // First page with fetch; the next page (end of list) with XHR when scrolled to the bottom.
    return route.fulfill({ contentType: 'text/html', body: page(`
      fetch('/i/api/graphql/q1/Bookmarks?v=1');
      let asked = false;
      addEventListener('scroll', () => {
        if (asked || innerHeight + scrollY < document.body.scrollHeight - 100) return;
        asked = true;
        const x = new XMLHttpRequest(); x.open('GET', '/i/api/graphql/q1/Bookmarks?v=2'); x.send();
      });`) });
  }
  if (url.includes('/alice/status/')) {
    // No GraphQL response at all: the DOM fallback must kick in.
    const art = (id, handle, text) => `<article data-testid="tweet"><div data-testid="User-Name"><span>${handle} name</span></div>
      <a href="/${handle}/status/${id}"><time datetime="2025-10-02T10:00:00.000Z">Oct 2</time></a>
      <div data-testid="tweetText">${text}</div></article>`;
    return route.fulfill({ contentType: 'text/html', body: page('').replace('fake x.com',
      art('1845000000000000800', 'alice', 'DOM one') + art('1845000000000000801', 'alice', 'DOM two') + art('1845000000000000802', 'bob', 'reply')) });
  }
  if (url.includes('/status/')) {
    return route.fulfill({ contentType: 'text/html', body: page(`
      fetch('/i/api/graphql/q2/TweetDetail?v=1').then(() => fetch('/i/api/graphql/q2/TweetDetail?v=2'));`) });
  }
  return route.fulfill({ status: 404, body: '' });
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');

const idb = (store) => sw.evaluate((store) => new Promise((res, rej) => {
  const r = indexedDB.open('x-bookmarks');
  r.onsuccess = () => { const q = r.result.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = rej; };
  r.onerror = rej;
}), store);

// Flow 1: passive capture.
const p = await ctx.newPage();
await p.goto('https://x.com/i/bookmarks');
await p.waitForTimeout(1500);
let items = await idb('items');
check('passive capture saves every bookmark', items.length === 5, `${items.length} items`);
const long = items.find((i) => i.id === '1845000000000000200');
check('long post has full note_tweet text', long?.posts[0].text.length > 600);
const partial = items.find((i) => i.id === '1845000000000000500');
check('thread bookmark flagged incomplete', partial?.thread_complete === false && partial.incomplete === 1);
check('saves wait in the local queue while signed out', (await idb('queue')).length === 5);

// Flow 1: auto-scroll sync stops at the end of the list.
const t0 = Date.now();
await sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://x.com/i/bookmarks' });
  await chrome.tabs.sendMessage(tab.id, { type: 'startSync' });
});
let state;
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(500);
  state = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://x.com/i/bookmarks' });
    return chrome.tabs.sendMessage(tab.id, { type: 'getPageState' });
  });
  if (!state.sync.running) break;
}
check('sync stops on its own at the end of the list', state.sync.stoppedReason === 'end of list', `${state.sync.stoppedReason} after ${Math.round((Date.now() - t0) / 1000)}s, ${state.sync.scrolls} scrolls`);
check('sync toast shown', (await p.locator('x-bookmarks-saver .toast').textContent()).startsWith('Sync finished'));

// Flow 2: thread page, save via the injected button.
const p2 = await ctx.newPage();
await p2.goto('https://x.com/naval/status/1845000000000000502');
await p2.waitForTimeout(1500);
await p2.locator('x-bookmarks-saver button').click();
await p2.waitForTimeout(800);
const toast = await p2.locator('x-bookmarks-saver .toast').textContent();
check('toast confirms the thread save', toast.startsWith('Saved thread · 6 posts'), toast);
items = await idb('items');
const up = items.find((i) => i.id === '1845000000000000500');
check('upgraded in place, same item id', items.filter((i) => i.match_ids.includes('1845000000000000502')).length === 1);
check('thread complete, ordered, same author only',
  up.thread_complete && up.posts.map((x) => x.id.slice(-3)).join() === '500,501,502,503,504,505', up.posts.map((x) => x.id.slice(-3)).join());
check('bookmarked_at kept from the bookmarks page', up.bookmarked_at === partial.bookmarked_at && up.bookmarked_post_id === '1845000000000000502');

// Flow 2 via the keyboard-shortcut path (same message the command handler sends).
await sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://x.com/naval/*' });
  await chrome.tabs.sendMessage(tab.id, { type: 'saveThread' });
});
await p2.waitForTimeout(500);
check('re-save via command message works', (await p2.locator('x-bookmarks-saver .toast').textContent()).startsWith('Saved thread'));

// Fallback: nothing captured, read the page.
const p3 = await ctx.newPage();
await p3.goto('https://x.com/alice/status/1845000000000000800');
await p3.waitForTimeout(1000);
await p3.locator('x-bookmarks-saver button').click();
await p3.waitForTimeout(800);
const t3 = await p3.locator('x-bookmarks-saver .toast').textContent();
check('DOM fallback saves same-author posts and says so', t3.includes('2 posts') && t3.includes('read from the page'), t3);

await ctx.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
