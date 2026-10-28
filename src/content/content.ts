// Isolated-world content script on x.com. Receives captured responses from the
// MAIN-world hook, keeps the per-tab cache of every post seen this page
// session, and runs both save flows.

import {
  HOOK_TAG,
  STOP_AFTER_KNOWN,
  type BookmarksReply,
  type HookMessage,
  type PageState,
  type SaveThreadReply,
  type Settings,
  type SyncState,
  type ToBackground,
  type ToContent,
} from '../shared/messages';
import { isBookmarksOperation, parseResponse } from '../shared/parser';
import { assembleThread, itemFromBookmark, itemFromThread } from '../shared/thread';
import type { ParsedPost } from '../shared/types';
import { domThread, readArticles } from './dom';
import { showToast, syncPageButton } from './ui';

const cache = new Map<string, ParsedPost>();
let captures = 0;
let bookmarkCaptures = 0;
let settings: Settings = { debug: false, viewerUrl: '' };

chrome.storage.local.get('settings').then(({ settings: s }) => (settings = { ...settings, ...(s as Settings) }));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) settings = { ...settings, ...(changes.settings.newValue as Settings) };
});

const send = <T>(msg: ToBackground) => chrome.runtime.sendMessage(msg) as Promise<T>;

export function pageKind(path = location.pathname): PageState['page'] {
  if (path.startsWith('/i/bookmarks')) return 'bookmarks';
  if (/^\/[^/]+\/status\/\d+/.test(path)) return 'post';
  return 'other';
}

function focalIdFromUrl(): string | null {
  return /^\/[^/]+\/status\/(\d+)/.exec(location.pathname)?.[1] ?? null;
}

// ── Capture ────────────────────────────────────────────────────────────────

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const data = e.data as HookMessage;
  if (!data || data.source !== HOOK_TAG || typeof data.op !== 'string') return;
  handleCapture(data.op, data.json);
});

function handleCapture(op: string, json: unknown) {
  const res = parseResponse(op, json);
  captures++;
  for (const p of res.posts) {
    const prev = cache.get(p.id);
    if (!prev || (prev.unavailable && !p.unavailable)) cache.set(p.id, p);
  }
  send({ type: 'captured', op, posts: res.posts.length, json: settings.debug ? json : undefined }).catch(() => {});
  if (isBookmarksOperation(op) && pageKind() === 'bookmarks') {
    bookmarkCaptures++;
    if (res.empty) sync.endReached = true;
    const posts = res.entries.map((e) => ({ e, p: cache.get(e.postId) })).filter((x) => x.p);
    void saveBookmarks(
      posts.map(({ e, p }) => itemFromBookmark(p!, e.sortIndex, new Date().toISOString())),
      false,
    );
  }
}

// ── Flow 1: bookmarks page ─────────────────────────────────────────────────

const sync: SyncState & { endReached: boolean } = {
  running: false,
  scrolls: 0,
  saved: 0,
  knownRun: 0,
  stoppedReason: null,
  endReached: false,
};

async function saveBookmarks(items: ReturnType<typeof itemFromBookmark>[], fallback: boolean) {
  if (items.length === 0) return;
  try {
    const reply = await send<BookmarksReply>({ type: 'bookmarks', items, fallback });
    for (const known of reply.known) {
      if (known) sync.knownRun++;
      else {
        sync.knownRun = 0;
        sync.saved++;
      }
    }
  } catch (e) {
    console.warn('[x-bookmarks] save failed', e);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

async function runSync() {
  if (sync.running) return;
  Object.assign(sync, { running: true, scrolls: 0, stoppedReason: null });
  const stop = (reason: string) => {
    sync.running = false;
    sync.stoppedReason = reason;
    showToast(`Sync finished · ${reason} · ${sync.saved} new`);
  };
  let idle = 0;
  while (sync.running) {
    if (sync.knownRun >= STOP_AFTER_KNOWN) return stop('reached saved bookmarks');
    if (sync.endReached) return stop('end of list');
    const el = document.scrollingElement ?? document.documentElement;
    const before = { height: el.scrollHeight, captures: bookmarkCaptures };
    window.scrollBy({ top: window.innerHeight * rand(0.9, 1.6), behavior: 'smooth' });
    sync.scrolls++;
    await sleep(rand(1500, 3000));
    if (!sync.running) break;
    if (bookmarkCaptures === 0) await saveVisibleBookmarks();
    const atBottom = window.innerHeight + window.scrollY >= el.scrollHeight - 80;
    idle = atBottom && el.scrollHeight === before.height && bookmarkCaptures === before.captures ? idle + 1 : 0;
    if (idle >= 4) return stop('end of list');
  }
  if (!sync.stoppedReason) sync.stoppedReason = 'stopped';
}

/** Fallback when the hook captured nothing on this page. */
async function saveVisibleBookmarks() {
  const posts = readArticles().filter((p) => !cache.has(p.id));
  for (const p of posts) cache.set(p.id, p);
  await saveBookmarks(
    posts.map((p) => itemFromBookmark(p, null, new Date().toISOString(), 'dom')),
    true,
  );
}

// ── Flow 2: post page ──────────────────────────────────────────────────────

let saving = false;
async function saveThread() {
  if (saving) return;
  const focalId = focalIdFromUrl();
  if (!focalId) return showToast('Open a post (x.com/<handle>/status/<id>) to save it');
  saving = true;
  try {
    let fallback = false;
    let thread = assembleThread(cache, focalId);
    if (!thread) {
      const posts = domThread(readArticles(), focalId);
      if (!posts) return showToast('Nothing to save yet — wait for the post to load');
      fallback = true;
      thread = { posts, rootId: posts[0].id, topLoaded: true };
    }
    const item = itemFromThread(thread, focalId, fallback ? 'dom' : 'graphql');
    const r = await send<SaveThreadReply>({ type: 'saveThread', item, fallback });
    if (!r?.ok) return showToast(`Save failed: ${r?.error ?? 'unknown error'}`, true);
    const n = r.postCount ?? item.post_count;
    const parts = [n > 1 ? `Saved thread · ${n} posts` : 'Saved post'];
    if (!r.threadComplete) parts.push('top of thread not loaded, scroll up and save again');
    if (fallback) parts.push('read from the page, long posts may be cut off');
    if (!r.signedIn) parts.push('saved locally, sign in to sync');
    showToast(parts.join(' · '));
  } catch (e) {
    showToast(`Save failed: ${e instanceof Error ? e.message : e}`, true);
  } finally {
    saving = false;
  }
}

// ── Messages from popup / service worker ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ToContent, _sender, reply) => {
  switch (msg.type) {
    case 'getPageState':
      reply({ page: pageKind(), captures, cached: cache.size, sync: { ...sync } } satisfies PageState);
      return;
    case 'startSync':
      if (pageKind() === 'bookmarks') void runSync();
      reply({ ok: true });
      return;
    case 'stopSync':
      sync.running = false;
      sync.stoppedReason = 'stopped';
      reply({ ok: true });
      return;
    case 'saveThread':
      void saveThread();
      reply({ ok: true });
      return;
  }
});

// ── Page button (SPA: re-check on every navigation) ────────────────────────

let lastPath = '';
setInterval(() => {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  if (pageKind() !== 'bookmarks' && sync.running) {
    sync.running = false;
    sync.stoppedReason = 'left the bookmarks page';
  }
  syncPageButton(pageKind() === 'post', saveThread);
}, 500);
