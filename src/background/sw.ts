// Service worker: routes messages, owns auth and the Firestore push loop.
// It may be stopped at any time; all state lives in IndexedDB / chrome.storage.

import { CONFIG } from '../config';
import type { BookmarksReply, SaveThreadReply, Settings, StatusReply, ToBackground } from '../shared/messages';
import { Auth } from './auth';
import * as db from './db';
import { FirestoreClient } from './firestore';
import { push, saveLocal } from './sync';

const auth = new Auth({ apiKey: CONFIG.firebase.apiKey, oauthClientId: CONFIG.oauthClientId, allowedEmail: CONFIG.allowedEmail });
const client = new FirestoreClient(CONFIG.firebase.projectId, () => auth.idToken());

async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { debug: false, viewerUrl: CONFIG.viewerUrl, ...(settings as Partial<Settings>) };
}

async function kick() {
  try {
    const r = await push(auth, client);
    await chrome.storage.local.set({ lastPush: { at: new Date().toISOString(), ...r } });
    await updateBadge();
  } catch (e) {
    console.warn('[x-bookmarks] push failed', e);
  }
}

async function updateBadge() {
  const { pending } = await db.stats();
  await chrome.action.setBadgeText({ text: pending > 0 ? String(pending) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#000' });
}

// Periodic retry: also covers coming back online, since MV3 workers get no reliable online event.
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('push', { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('push', { periodInMinutes: 1 });
  void kick();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'push') void kick();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-thread') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'saveThread' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg: ToBackground, sender, reply) => {
  // Only accept messages from our own extension pages and content scripts.
  if (sender.id !== chrome.runtime.id) return;
  handle(msg)
    .then(reply)
    .catch((e) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
});

async function handle(msg: ToBackground): Promise<unknown> {
  switch (msg.type) {
    case 'bookmarks': {
      const known: boolean[] = [];
      for (const item of msg.items) {
        const before = await db.knownPostIds([item.bookmarked_post_id]);
        known.push(before.has(item.bookmarked_post_id));
        await saveLocal(item);
      }
      void kick();
      return { known } satisfies BookmarksReply;
    }
    case 'saveThread': {
      const out = await saveLocal(msg.item);
      const signedIn = !!(await auth.session());
      void kick();
      return {
        ok: true,
        postCount: out.item.post_count,
        threadComplete: out.item.thread_complete,
        existed: out.existed,
        signedIn,
      } satisfies SaveThreadReply;
    }
    case 'captured': {
      const { captures = {} } = await chrome.storage.session.get('captures');
      const c = captures as Record<string, number>;
      c[msg.op] = (c[msg.op] ?? 0) + 1;
      await chrome.storage.session.set({ captures: c, lastCaptureAt: new Date().toISOString() });
      if (msg.json !== undefined && (await getSettings()).debug) await downloadDebug(msg.op, msg.json);
      return { ok: true };
    }
    case 'getStatus':
      return status();
    case 'signIn': {
      const s = await auth.signIn();
      await db.resetBackoff();
      void kick();
      return { ok: true, email: s.email };
    }
    case 'signOut':
      await auth.signOut();
      return { ok: true };
    case 'syncNow':
      await db.resetBackoff();
      await kick();
      return status();
    case 'spike':
      return spike();
  }
}

async function status(): Promise<StatusReply> {
  const [session, st, lastSyncAt, needs, settings, { lastPush }] = await Promise.all([
    auth.session(),
    db.stats(),
    db.getMeta<string>('lastSyncAt'),
    db.incompleteItems(10),
    getSettings(),
    chrome.storage.local.get('lastPush'),
  ]);
  const queue = await db.dueQueue(Number.MAX_SAFE_INTEGER, 1);
  return {
    signedIn: !!session,
    email: session?.email ?? null,
    ...st,
    lastSyncAt: lastSyncAt ?? null,
    lastError: queue[0]?.lastError ?? (lastPush as any)?.error ?? null,
    needsThreadSave: needs.map((i) => ({ id: i.id, url: i.url, author_handle: i.author_handle, preview: i.preview })),
    viewerUrl: settings.viewerUrl,
  };
}

async function downloadDebug(op: string, json: unknown) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(json, null, 2));
  await chrome.downloads.download({ url, filename: `x-bookmarks-debug/${op}-${stamp}.json`, conflictAction: 'uniquify', saveAs: false });
}

/** Milestone 0 checks (a) and (b), run from the options page. (c) shows up in the capture counters. */
async function spike() {
  const lines: { check: string; ok: boolean; detail: string }[] = [];
  const add = (check: string, ok: boolean, detail: string) => lines.push({ check, ok, detail });
  try {
    const { idToken, redirectUri } = await auth.googleIdToken(true);
    add('Google ID token from launchWebAuthFlow', true, `redirect URI ${redirectUri}`);
    const s = await auth.exchange(idToken, redirectUri);
    add('Exchanged for a Firebase ID token', true, `uid ${s.uid}, ${s.email}`);
    const token = (await auth.idToken())!;

    await client.setRaw(s.uid, 'test', { source: 'spike', at: new Date().toISOString() });
    const back = await client.getDoc(s.uid, 'test');
    add('Write + read users/{uid}/x_items/test', back?.data.source === 'spike', back ? `updateTime ${back.updateTime}` : 'not found');

    const anon = await client.rawGet(`users/${s.uid}/x_items/test`, null);
    add('Rules reject unauthenticated read', anon === 403 || anon === 401, `HTTP ${anon}`);
    const other = await client.rawGet(`users/someone-else-${crypto.randomUUID()}/x_items/test`, token);
    add("Rules reject another uid's data", other === 403, `HTTP ${other}`);
    await client.deleteDoc(s.uid, 'test');
  } catch (e) {
    add('Error', false, e instanceof Error ? e.message : String(e));
  }
  const { captures = {}, lastCaptureAt = null } = await chrome.storage.session.get(['captures', 'lastCaptureAt']);
  return { lines, captures, lastCaptureAt };
}
