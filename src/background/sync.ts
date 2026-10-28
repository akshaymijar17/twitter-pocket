// Save locally, then push to Firestore with retries. The merge rules live in
// shared/thread.ts and run on both sides: against the local copy when saving,
// and against the Firestore copy (read just before writing) when pushing.

import { approxSize, mergeItem, pickExt, SIZE_WARN_BYTES } from '../shared/thread';
import type { ExtItem } from '../shared/types';
import type { Auth } from './auth';
import * as db from './db';
import { FirestoreClient, FirestoreError, type WriteOp } from './firestore';

export interface SaveOutcome {
  itemId: string;
  /** True when this capture added nothing new. */
  unchanged: boolean;
  /** True when an item for these posts already existed locally before this save. */
  existed: boolean;
  item: ExtItem;
}

export async function saveLocal(incoming: ExtItem): Promise<SaveOutcome> {
  const matches = await db.findItems(incoming.match_ids);
  const existing = matches.find((m) => m.id === incoming.id) ?? matches.sort((a, b) => b.post_count - a.post_count)[0];
  const { item, changed } = mergeItem(existing ?? null, incoming);
  if (existing && changed.length === 0) return { itemId: existing.id, unchanged: true, existed: true, item };
  const local: db.LocalItem = {
    ...item,
    match_ids: [...new Set([...item.match_ids, ...(existing?.match_ids ?? [])])],
    incomplete: item.thread_complete ? 0 : 1,
    remote_id: existing?.remote_id,
    local_saved_at: new Date().toISOString(),
  };
  await db.putItemAndQueue(local);
  return { itemId: local.id, unchanged: false, existed: !!existing, item };
}

export function backoffMs(attempts: number, rand = Math.random()): number {
  const base = Math.min(30 * 60_000, 5_000 * 2 ** attempts);
  return Math.round(base * (0.75 + rand * 0.5));
}

const BATCH = 20;
const WRITABLE = new Set<string>([
  'id',
  'type',
  'thread_complete',
  'author_name',
  'author_handle',
  'author_id',
  'url',
  'created_at',
  'conversation_id',
  'bookmarked_post_id',
  'bookmarked_at',
  'bookmark_sort_index',
  'post_count',
  'posts',
  'match_ids',
  'preview',
  'search_text',
  'search_tokens',
  'source',
  'capture_method',
]);

export interface PushReport {
  pushed: number;
  failed: number;
  skippedSignedOut: boolean;
  remaining: number;
}

let running: Promise<PushReport> | null = null;

/** Drains the queue. Concurrent calls share one run. */
export function push(auth: Auth, client: FirestoreClient): Promise<PushReport> {
  if (!running) running = doPush(auth, client).finally(() => (running = null));
  return running;
}

async function doPush(auth: Auth, client: FirestoreClient): Promise<PushReport> {
  const report: PushReport = { pushed: 0, failed: 0, skippedSignedOut: false, remaining: 0 };
  for (let round = 0; round < 50; round++) {
    const session = await auth.session();
    if (!session) {
      report.skippedSignedOut = true;
      break;
    }
    const due = await db.dueQueue(Date.now(), BATCH);
    if (due.length === 0) break;
    const { pushed, failed, raced } = await pushBatch(session.uid, due, auth, client);
    report.pushed += pushed;
    report.failed += failed;
    if (pushed === 0 && raced === 0) break;
  }
  report.remaining = await db.queueSize();
  if (report.pushed > 0) await db.setMeta('lastSyncAt', new Date().toISOString());
  return report;
}

async function pushBatch(uid: string, due: db.QueueEntry[], auth: Auth, client: FirestoreClient) {
  let pushed = 0;
  let failed = 0;
  let raced = 0;
  const handled = new Set<db.QueueEntry>();
  const ops: WriteOp[] = [];
  const pending: { entry: db.QueueEntry; local: db.LocalItem; merged: ExtItem; remoteId: string }[] = [];

  try {
    for (const entry of due) {
      const local = await db.getItem(entry.itemId);
      if (!local) {
        await db.dropQueueEntry(entry);
        handled.add(entry);
        continue;
      }
      const remote = await client.findByMatchIds(uid, [...local.match_ids, ...(local.remote_id ? [local.remote_id] : [])]);
      const target =
        remote.find((r) => r.id === local.remote_id) ??
        remote.find((r) => r.id === local.id) ??
        remote.sort((a, b) => (b.data.post_count ?? 0) - (a.data.post_count ?? 0))[0];
      const ext = pickExt(local);

      if (!target) {
        warnIfLarge(ext);
        const data = { ...ext, status: 'unread', favorite: false, tags: [] };
        ops.push({ kind: 'create', id: local.id, data, serverTimestamps: ['saved_at', 'created_in_db_at'] });
        pending.push({ entry, local, merged: ext, remoteId: local.id });
        continue;
      }

      const { item: merged, changed } = mergeItem({ ...(target.data as ExtItem), id: target.id }, ext);
      const fields = changed.filter((f) => WRITABLE.has(f) && f !== 'id');
      if (fields.length === 0) {
        await db.markPushed(entry, toLocal(local, merged, target.id));
        handled.add(entry);
        pushed++;
        continue;
      }
      warnIfLarge(merged);
      const data: Record<string, unknown> = {};
      for (const f of fields) data[f] = (merged as any)[f];
      ops.push({ kind: 'update', id: target.id, data, fields, updateTime: target.updateTime, serverTimestamps: ['saved_at'] });
      pending.push({ entry, local, merged, remoteId: target.id });
    }

    const statuses = await client.batchWrite(uid, ops);
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const s = statuses[i];
      handled.add(p.entry);
      if (s?.ok) {
        await db.markPushed(p.entry, toLocal(p.local, p.merged, p.remoteId));
        pushed++;
      } else {
        failed++;
        // 6 = already exists, 9 = changed since we read it: another write got there first; retry now.
        const lostRace = !!s && (s.code === 6 || s.code === 9);
        if (lostRace) raced++;
        await db.markFailed(p.entry, s?.message ?? 'no write status', lostRace ? 0 : backoffMs(p.entry.attempts));
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof FirestoreError && e.status === 401) await auth.refresh().catch(() => null);
    for (const entry of due) {
      if (handled.has(entry)) continue;
      await db.markFailed(entry, msg, backoffMs(entry.attempts));
      failed++;
    }
  }
  return { pushed, failed, raced };
}

function toLocal(local: db.LocalItem, merged: ExtItem, remoteId: string): db.LocalItem {
  return {
    ...local,
    ...merged,
    id: local.id,
    match_ids: [...new Set([...local.match_ids, ...merged.match_ids])],
    incomplete: merged.thread_complete ? 0 : 1,
    remote_id: remoteId,
  };
}

function warnIfLarge(item: ExtItem) {
  const size = approxSize(item);
  if (size > SIZE_WARN_BYTES) console.warn(`[x-bookmarks] item ${item.id} is ${Math.round(size / 1024)} KB (Firestore limit is 1 MiB)`);
}
