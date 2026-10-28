import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth, type Session, type SessionStore } from '../src/background/auth';
import * as db from '../src/background/db';
import { decodeFields, encodeFields, FirestoreClient, FirestoreError, type WriteOp, type WriteStatus } from '../src/background/firestore';
import { push, saveLocal } from '../src/background/sync';
import { parseResponse } from '../src/shared/parser';
import { assembleThread, itemFromBookmark, itemFromThread } from '../src/shared/thread';
import type { ParsedPost } from '../src/shared/types';

const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

/** In-memory Firestore with the precondition semantics the sync code relies on. */
class FakeFirestore {
  docs = new Map<string, { data: Record<string, any>; updateTime: string }>();
  clock = 0;
  online = true;
  writes: WriteOp[] = [];
  private tick() {
    return new Date(Date.UTC(2026, 0, 1) + ++this.clock * 1000).toISOString();
  }
  async findByMatchIds(_uid: string, ids: string[]) {
    if (!this.online) throw new TypeError('Failed to fetch');
    return [...this.docs]
      .filter(([, d]) => (d.data.match_ids as string[]).some((m) => ids.includes(m)))
      .map(([id, d]) => ({ id, name: id, updateTime: d.updateTime, data: structuredClone(d.data) }));
  }
  async batchWrite(_uid: string, ops: WriteOp[]): Promise<WriteStatus[]> {
    if (!this.online) throw new TypeError('Failed to fetch');
    this.writes.push(...ops);
    return ops.map((op) => {
      const cur = this.docs.get(op.id);
      const now = this.tick();
      const ts = Object.fromEntries(op.serverTimestamps.map((f) => [f, now]));
      if (op.kind === 'create') {
        if (cur) return { ok: false, code: 6 };
        this.docs.set(op.id, { data: structuredClone({ ...op.data, ...ts }), updateTime: now });
      } else {
        if (!cur || cur.updateTime !== op.updateTime) return { ok: false, code: 9 };
        const next = { ...cur.data };
        for (const f of op.fields) next[f] = structuredClone(op.data[f]);
        this.docs.set(op.id, { data: { ...next, ...ts }, updateTime: now });
      }
      return { ok: true, code: 0 };
    });
  }
}

function memStore(initial: Session | null): SessionStore & { s: Session | null } {
  return {
    s: initial,
    async load() {
      return this.s;
    },
    async save(s) {
      this.s = s;
    },
  };
}

const session: Session = { uid: 'u1', email: 'me@example.com', idToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };

const bookmarks = parseResponse('Bookmarks', fx('bookmarks-page1.json'));
const bmPost = (suffix: string) => bookmarks.posts.find((p) => p.id.endsWith(suffix))!;

function threadItem(extraFiles: string[] = []) {
  const cache = new Map<string, ParsedPost>();
  for (const f of ['tweetdetail-thread.json', ...extraFiles]) for (const p of parseResponse('TweetDetail', fx(f)).posts) cache.set(p.id, p);
  return itemFromThread(assembleThread(cache, '1845000000000000502')!, '1845000000000000502', 'graphql');
}

let fs: FakeFirestore;
let store: ReturnType<typeof memStore>;
let auth: Auth;
const client = () => fs as unknown as FirestoreClient;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  db.resetDbForTests();
  fs = new FakeFirestore();
  store = memStore(session);
  auth = new Auth({ apiKey: 'k', oauthClientId: 'c' }, store);
});

describe('local-first save and push', () => {
  it('bookmark → Firestore doc with viewer defaults; re-seeing it is a no-op', async () => {
    const it1 = itemFromBookmark(bmPost('100'), 's', '2026-01-01T00:00:00.000Z');
    const first = await saveLocal(it1);
    expect(first.existed).toBe(false);
    expect((await db.stats()).pending).toBe(1);

    const r = await push(auth, client());
    expect(r).toMatchObject({ pushed: 1, failed: 0, remaining: 0 });
    const doc = fs.docs.get('1845000000000000100')!.data;
    expect(doc).toMatchObject({ status: 'unread', favorite: false, tags: [], type: 'post', thread_complete: true, bookmarked_at: '2026-01-01T00:00:00.000Z' });
    expect(doc.created_in_db_at).toBeTruthy();
    expect(doc.saved_at).toBeTruthy();

    const again = await saveLocal(itemFromBookmark(bmPost('100'), 's', '2026-02-01T00:00:00.000Z'));
    expect(again).toMatchObject({ unchanged: true, existed: true });
    expect(await db.queueSize()).toBe(0);
  });

  it('offline / signed out: saves stay queued and reach Firestore later', async () => {
    store.s = null;
    await saveLocal(itemFromBookmark(bmPost('200'), 's', '2026-01-01T00:00:00.000Z'));
    expect(await push(auth, client())).toMatchObject({ pushed: 0, skippedSignedOut: true, remaining: 1 });

    store.s = session;
    fs.online = false;
    expect(await push(auth, client())).toMatchObject({ pushed: 0, failed: 1, remaining: 1 });
    expect(fs.docs.size).toBe(0);

    fs.online = true;
    await db.resetBackoff();
    expect(await push(auth, client())).toMatchObject({ pushed: 1, remaining: 0 });
    expect(fs.docs.get('1845000000000000200')!.data.posts[0].text.length).toBeGreaterThan(600);
  });

  it('thread save upgrades a partial bookmark in place, keeping bookmarked_at and viewer fields', async () => {
    const partial = itemFromBookmark(bmPost('502'), 'idx', '2026-01-01T00:00:00.000Z');
    await saveLocal(partial);
    await push(auth, client());
    const id = '1845000000000000500';
    expect(fs.docs.get(id)!.data).toMatchObject({ thread_complete: false, type: 'thread', post_count: 1 });

    // The user works with it in the viewer.
    const d = fs.docs.get(id)!;
    Object.assign(d.data, { status: 'read', favorite: true, tags: ['wealth'] });
    const createdInDb = d.data.created_in_db_at;

    await saveLocal(threadItem(['tweetdetail-showmore.json']));
    await push(auth, client());

    expect(fs.docs.size).toBe(1);
    const up = fs.docs.get(id)!.data;
    expect(up).toMatchObject({
      thread_complete: true,
      type: 'thread',
      post_count: 6,
      bookmarked_at: '2026-01-01T00:00:00.000Z',
      bookmarked_post_id: '1845000000000000502',
      bookmark_sort_index: 'idx',
      status: 'read',
      favorite: true,
      tags: ['wealth'],
      created_in_db_at: createdInDb,
    });
    expect(up.posts.map((p: any) => p.id.slice(-3))).toEqual(['500', '501', '502', '503', '504', '505']);
    const update = fs.writes.at(-1)!;
    expect(update.kind).toBe('update');
    if (update.kind === 'update') {
      for (const f of ['status', 'favorite', 'tags', 'created_in_db_at', 'bookmarked_at']) expect(update.fields).not.toContain(f);
    }
  });

  it('a bookmark seen after a full thread save does not downgrade it, but fills bookmarked_at', async () => {
    await saveLocal(threadItem());
    await push(auth, client());
    const id = '1845000000000000500';
    expect(fs.docs.get(id)!.data.bookmarked_at).toBeNull();

    const r = await saveLocal(itemFromBookmark(bmPost('502'), 'idx', '2026-03-01T00:00:00.000Z'));
    expect(r.existed).toBe(true);
    await push(auth, client());
    expect(fs.docs.get(id)!.data).toMatchObject({ thread_complete: true, post_count: 5, bookmarked_at: '2026-03-01T00:00:00.000Z' });
  });

  it('finds the remote doc even when the local DB is empty (reinstall), and upgrades it', async () => {
    await saveLocal(itemFromBookmark(bmPost('502'), 'idx', '2026-01-01T00:00:00.000Z'));
    await push(auth, client());
    globalThis.indexedDB = new IDBFactory();
    db.resetDbForTests();
    await saveLocal(threadItem());
    await push(auth, client());
    expect([...fs.docs.keys()]).toEqual(['1845000000000000500']);
    expect(fs.docs.get('1845000000000000500')!.data.bookmarked_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('retries after a concurrent write changed the doc', async () => {
    await saveLocal(itemFromBookmark(bmPost('502'), 'idx', '2026-01-01T00:00:00.000Z'));
    await push(auth, client());
    await saveLocal(threadItem());
    // Viewer edit lands between our read and our write.
    const orig = fs.batchWrite.bind(fs);
    let once = true;
    fs.batchWrite = async (uid, ops) => {
      if (once) {
        once = false;
        const d = fs.docs.get('1845000000000000500')!;
        d.data.tags = ['x'];
        d.updateTime = 'changed';
      }
      return orig(uid, ops);
    };
    const r = await push(auth, client());
    expect(r.remaining).toBe(0);
    expect(fs.docs.get('1845000000000000500')!.data).toMatchObject({ tags: ['x'], thread_complete: true });
  });

  it('popup stats and the needs-thread-save list', async () => {
    await saveLocal(itemFromBookmark(bmPost('100'), null, '2026-01-01T00:00:00.000Z'));
    await saveLocal(itemFromBookmark(bmPost('502'), null, '2026-01-02T00:00:00.000Z'));
    expect(await db.stats()).toEqual({ total: 2, incomplete: 1, pending: 2 });
    expect((await db.incompleteItems(10)).map((i) => i.id)).toEqual(['1845000000000000500']);
    expect([...(await db.knownPostIds(['1845000000000000502', '1845000000000000999']))]).toEqual(['1845000000000000502']);
  });
});

describe('Firestore codec and REST client', () => {
  it('round-trips items, with timestamps as timestampValue', () => {
    const item = threadItem();
    const enc = encodeFields(item as any);
    expect(enc.created_at).toEqual({ timestampValue: item.created_at });
    expect(enc.bookmarked_at).toEqual({ nullValue: null });
    expect(enc.post_count).toEqual({ integerValue: '5' });
    expect((enc.posts as any).arrayValue.values[0].mapValue.fields.created_at.timestampValue).toBeTruthy();
    expect(decodeFields(enc)).toEqual(item);
  });

  it('batchWrite sends preconditions, masks and server timestamps', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ status: [{}, { code: 9, message: 'stale' }] })));
    const c = new FirestoreClient('proj', async () => 'tok', fetchFn as any);
    const res = await c.batchWrite('u1', [
      { kind: 'create', id: 'a', data: { x: 1 }, serverTimestamps: ['saved_at', 'created_in_db_at'] },
      { kind: 'update', id: 'b', data: { posts: [] }, fields: ['posts'], updateTime: 'T', serverTimestamps: ['saved_at'] },
    ]);
    expect(res).toEqual([{ ok: true, code: 0, message: undefined }, { ok: false, code: 9, message: 'stale' }]);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://firestore.googleapis.com/v1/projects/proj/databases/(default)/documents:batchWrite');
    expect((init!.headers as any).Authorization).toBe('Bearer tok');
    const body = JSON.parse(init!.body as string);
    expect(body.writes[0].currentDocument).toEqual({ exists: false });
    expect(body.writes[0].update.name).toBe('projects/proj/databases/(default)/documents/users/u1/x_items/a');
    expect(body.writes[1]).toMatchObject({ updateMask: { fieldPaths: ['posts'] }, currentDocument: { updateTime: 'T' } });
  });

  it('refuses to call Firestore without a token', async () => {
    const c = new FirestoreClient('proj', async () => null, vi.fn() as any);
    await expect(c.findByMatchIds('u1', ['1'])).rejects.toBeInstanceOf(FirestoreError);
  });
});

describe('auth token refresh', () => {
  it('refreshes near expiry, once, and signs out on a revoked refresh token', async () => {
    const now = 1_000_000;
    const s = memStore({ ...session, expiresAt: now + 60_000 });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id_token: 'new', refresh_token: 'r2', expires_in: '3600', user_id: 'u1' })));
    const a = new Auth({ apiKey: 'k', oauthClientId: 'c' }, s, fetchFn as any, () => now);
    const [t1, t2] = await Promise.all([a.idToken(), a.idToken()]);
    expect([t1, t2]).toEqual(['new', 'new']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(s.s).toMatchObject({ refreshToken: 'r2', expiresAt: now + 3600_000 });

    s.s = { ...s.s!, expiresAt: now };
    fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'TOKEN_EXPIRED' } }), { status: 400 }));
    expect(await a.idToken()).toBeNull();
    expect(s.s).toBeNull();
  });
});
