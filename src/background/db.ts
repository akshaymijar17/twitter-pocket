// Local-first store. Every save lands here first; the queue is drained to
// Firestore by sync.ts. Nothing leaves the queue until Firestore confirms.

import type { ExtItem } from '../shared/types';

export interface LocalItem extends ExtItem {
  /** 1 while thread_complete is false (booleans cannot be indexed). */
  incomplete: 0 | 1;
  /** Remote doc id once known (may differ from `id` if an existing doc was upgraded in place). */
  remote_id?: string;
  local_saved_at: string;
}

export interface QueueEntry {
  /** Local item id; one entry per item, newer saves replace older ones. */
  itemId: string;
  rev: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  enqueuedAt: number;
}

const DB_NAME = 'x-bookmarks';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const items = db.createObjectStore('items', { keyPath: 'id' });
      items.createIndex('match_ids', 'match_ids', { multiEntry: true });
      items.createIndex('incomplete', 'incomplete');
      db.createObjectStore('queue', { keyPath: 'itemId' });
      db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/** For tests. */
export function resetDbForTests() {
  dbPromise = null;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export async function getItem(id: string): Promise<LocalItem | undefined> {
  const db = await openDb();
  return wrap(db.transaction('items').objectStore('items').get(id));
}

/** Local items containing any of these post ids. */
export async function findItems(postIds: string[]): Promise<LocalItem[]> {
  const db = await openDb();
  const idx = db.transaction('items').objectStore('items').index('match_ids');
  const found = new Map<string, LocalItem>();
  for (const id of new Set(postIds)) {
    for (const it of await wrap(idx.getAll(id))) found.set(it.id, it);
  }
  return [...found.values()];
}

export async function knownPostIds(postIds: string[]): Promise<Set<string>> {
  const db = await openDb();
  const idx = db.transaction('items').objectStore('items').index('match_ids');
  const out = new Set<string>();
  for (const id of new Set(postIds)) if ((await wrap(idx.count(id))) > 0) out.add(id);
  return out;
}

/** Writes the item and (re)queues it in one transaction. */
export async function putItemAndQueue(item: LocalItem, replacesId?: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['items', 'queue'], 'readwrite');
  const items = tx.objectStore('items');
  const queue = tx.objectStore('queue');
  if (replacesId && replacesId !== item.id) {
    items.delete(replacesId);
    queue.delete(replacesId);
  }
  items.put(item);
  const prev: QueueEntry | undefined = await wrap(queue.get(item.id));
  queue.put({
    itemId: item.id,
    rev: (prev?.rev ?? 0) + 1,
    attempts: 0,
    nextAttemptAt: 0,
    enqueuedAt: prev?.enqueuedAt ?? Date.now(),
  } satisfies QueueEntry);
  await done(tx);
}

export async function dueQueue(now: number, limit: number): Promise<QueueEntry[]> {
  const db = await openDb();
  const all: QueueEntry[] = await wrap(db.transaction('queue').objectStore('queue').getAll());
  return all
    .filter((e) => e.nextAttemptAt <= now)
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
    .slice(0, limit);
}

export async function queueSize(): Promise<number> {
  const db = await openDb();
  return wrap(db.transaction('queue').objectStore('queue').count());
}

/**
 * Records a successful push: stores the item as Firestore now has it and
 * drops the queue entry, unless a newer local save arrived meanwhile.
 */
export async function markPushed(entry: QueueEntry, item: LocalItem): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['items', 'queue'], 'readwrite');
  const queue = tx.objectStore('queue');
  const cur: QueueEntry | undefined = await wrap(queue.get(entry.itemId));
  if (cur && cur.rev === entry.rev) {
    queue.delete(entry.itemId);
    tx.objectStore('items').put(item);
  }
  await done(tx);
}

export async function dropQueueEntry(entry: QueueEntry): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('queue', 'readwrite');
  tx.objectStore('queue').delete(entry.itemId);
  await done(tx);
}

export async function markFailed(entry: QueueEntry, error: string, retryInMs: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('queue', 'readwrite');
  const queue = tx.objectStore('queue');
  const cur: QueueEntry | undefined = await wrap(queue.get(entry.itemId));
  if (cur && cur.rev === entry.rev) {
    queue.put({ ...cur, attempts: cur.attempts + 1, nextAttemptAt: Date.now() + retryInMs, lastError: error });
  }
  await done(tx);
}

/** Makes every queued entry due now (after sign-in, or a manual "sync now"). */
export async function resetBackoff(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('queue', 'readwrite');
  const queue = tx.objectStore('queue');
  const all: QueueEntry[] = await wrap(queue.getAll());
  for (const e of all) queue.put({ ...e, nextAttemptAt: 0 });
  await done(tx);
}

export async function stats(): Promise<{ total: number; incomplete: number; pending: number }> {
  const db = await openDb();
  const tx = db.transaction(['items', 'queue']);
  const [total, incomplete, pending] = await Promise.all([
    wrap(tx.objectStore('items').count()),
    wrap(tx.objectStore('items').index('incomplete').count(1)),
    wrap(tx.objectStore('queue').count()),
  ]);
  return { total, incomplete, pending };
}

export async function incompleteItems(limit: number): Promise<LocalItem[]> {
  const db = await openDb();
  const all: LocalItem[] = await wrap(db.transaction('items').objectStore('items').index('incomplete').getAll(1));
  return all.sort((a, b) => (b.bookmarked_at ?? b.local_saved_at).localeCompare(a.bookmarked_at ?? a.local_saved_at)).slice(0, limit);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction('meta').objectStore('meta').get(key));
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await done(tx);
}
