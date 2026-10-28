// Pure logic: thread assembly, item building, thread detection, and the
// merge rules used both locally (IndexedDB) and remotely (Firestore).

import { compareIds, postUrl, timeFromSnowflake } from './parser';
import type { ExtItem, ItemDoc, ParsedPost, StoredPost } from './types';

export interface AssembledThread {
  posts: ParsedPost[];
  rootId: string;
  /** False when a same-author ancestor is referenced but not loaded on the page. */
  topLoaded: boolean;
}

/**
 * Focal post plus the same-author chain above it (ancestors) and below it
 * (descendants), from every post loaded on the page. Replies by other people
 * are left out.
 */
export function assembleThread(cache: Map<string, ParsedPost>, focalId: string): AssembledThread | null {
  const focal = cache.get(focalId);
  if (!focal || focal.unavailable) return null;
  const author = focal.author_id;

  const ancestors: ParsedPost[] = [];
  let topLoaded = true;
  let cur = focal;
  const seen = new Set([focal.id]);
  while (cur.in_reply_to_status_id && cur.in_reply_to_user_id === author) {
    const parent = cache.get(cur.in_reply_to_status_id);
    if (!parent) {
      topLoaded = false;
      break;
    }
    if (seen.has(parent.id)) break;
    seen.add(parent.id);
    if (parent.unavailable) {
      // A deleted post inside a self-thread: keep the gap visible, then bridge
      // to the conversation root (if loaded and by the same author).
      ancestors.unshift(parent);
      const root = cur.conversation_id ? cache.get(cur.conversation_id) : undefined;
      if (root && !root.unavailable && root.author_id === author && !seen.has(root.id)) {
        const top: ParsedPost[] = [root];
        seen.add(root.id);
        for (let next = sameAuthorChild(cache, root, seen); next; next = sameAuthorChild(cache, next, seen)) {
          seen.add(next.id);
          top.push(next);
        }
        ancestors.unshift(...top);
      } else {
        topLoaded = false;
      }
      break;
    }
    if (parent.author_id !== author) break;
    ancestors.unshift(parent);
    cur = parent;
  }

  // If the author replied to themselves more than once, the earliest reply continues the thread.
  const descendants: ParsedPost[] = [];
  for (let next = sameAuthorChild(cache, focal, seen); next; next = sameAuthorChild(cache, next, seen)) {
    seen.add(next.id);
    descendants.push(next);
  }

  const posts = [...ancestors, focal, ...descendants];
  return { posts, rootId: posts[0].id, topLoaded };
}

function sameAuthorChild(cache: Map<string, ParsedPost>, parent: ParsedPost, seen: Set<string>): ParsedPost | undefined {
  let best: ParsedPost | undefined;
  for (const p of cache.values()) {
    if (p.in_reply_to_status_id !== parent.id || p.author_id !== parent.author_id || p.unavailable || seen.has(p.id)) continue;
    if (!best || compareIds(p.id, best.id) < 0) best = p;
  }
  return best;
}

const THREAD_TEXT_HINT = /🧵|(^|\s)1\s*\/\s*(\d+|n)?(\s|$)|\bthread\b\s*[:👇⬇↓]|\(1\/\d+\)/i;

/** Bookmark-page heuristic: is this post part of a thread worth saving in full? */
export function looksLikeThread(p: ParsedPost): boolean {
  if (p.unavailable) return false;
  if (p.in_reply_to_status_id && p.in_reply_to_user_id && p.in_reply_to_user_id === p.author_id) return true;
  if (p.conversation_id && p.conversation_id !== p.id) return true;
  if (p.self_thread_id) return true;
  return THREAD_TEXT_HINT.test(p.text);
}

export function toStoredPost(p: ParsedPost): StoredPost {
  return {
    id: p.id,
    text: p.text,
    created_at: p.created_at ?? timeFromSnowflake(p.id),
    media: p.media,
    quoted: p.quoted,
    unavailable: p.unavailable,
  };
}

const URL_RE = /https?:\/\/[^\s]+/g;

export function tokenize(text: string, cap = 500): string[] {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.match(URL_RE) ?? []) {
    try {
      out.add(new URL(m).hostname.replace(/^www\./, ''));
    } catch {
      /* not a URL */
    }
  }
  const words = lower.replace(URL_RE, ' ').match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const w of words) {
    if (out.size >= cap) break;
    if (w.length >= 2 || /\p{Script=Han}/u.test(w)) out.add(w);
  }
  return [...out].slice(0, cap);
}

interface BuildOpts {
  id: string;
  posts: ParsedPost[];
  author: { id: string | null; name: string | null; handle: string | null };
  threadComplete: boolean;
  isThread: boolean;
  bookmarkedPostId: string;
  bookmarkedAt: string | null;
  bookmarkSortIndex?: string | null;
  captureMethod: 'graphql' | 'dom';
  conversationId?: string | null;
  rootId?: string;
}

export function buildItem(o: BuildOpts): ExtItem {
  return finalize({
    id: o.id,
    type: o.isThread ? 'thread' : 'post',
    thread_complete: o.threadComplete,
    author_name: o.author.name ?? o.author.handle ?? '',
    author_handle: o.author.handle ?? '',
    author_id: o.author.id,
    url: postUrl(o.author.handle, o.rootId ?? o.posts[0]?.id ?? o.id),
    created_at: null,
    conversation_id: o.conversationId ?? o.posts[0]?.conversation_id ?? null,
    bookmarked_post_id: o.bookmarkedPostId,
    bookmarked_at: o.bookmarkedAt,
    bookmark_sort_index: o.bookmarkSortIndex ?? null,
    post_count: 0,
    posts: o.posts.map(toStoredPost),
    match_ids: [],
    preview: '',
    search_text: '',
    search_tokens: [],
    source: 'x',
    capture_method: o.captureMethod,
  });
}

/** Recomputes every field derived from `posts`. */
export function finalize(item: ExtItem): ExtItem {
  const posts = item.posts;
  const first = posts.find((p) => !p.unavailable) ?? posts[0];
  const allText = posts.map((p) => [p.text, p.quoted ? `${p.quoted.author_handle ?? ''} ${p.quoted.text}` : ''].join(' ')).join('\n');
  const authorBits = `${item.author_name} @${item.author_handle} ${item.author_handle}`;
  const search_text = `${allText}\n${authorBits}`.toLowerCase();
  return {
    ...item,
    post_count: posts.length,
    created_at: posts[0]?.created_at ?? item.created_at,
    match_ids: [...new Set([item.id, ...posts.map((p) => p.id)])],
    preview: (first?.text ?? '').slice(0, 200),
    search_text,
    search_tokens: tokenize(search_text),
  };
}

function byChrono(a: StoredPost, b: StoredPost): number {
  return compareIds(a.id, b.id);
}

function unionPosts(a: StoredPost[], b: StoredPost[]): StoredPost[] {
  const map = new Map<string, StoredPost>();
  for (const p of a) map.set(p.id, p);
  for (const p of b) {
    const prev = map.get(p.id);
    // Newer capture wins unless it lost information (unavailable now, or text got shorter from the DOM).
    if (!prev || (!p.unavailable && (prev.unavailable || p.text.length >= prev.text.length))) map.set(p.id, p);
  }
  return [...map.values()].sort(byChrono);
}

export interface MergeResult {
  item: ExtItem;
  /** Extension-owned fields whose value differs from `existing`. Empty means no write is needed. */
  changed: string[];
}

/**
 * Merges an incoming capture into an existing item. Keeps the existing id,
 * the original bookmark info, and never touches viewer-owned fields.
 *
 * - complete incoming → replaces content (union with a previous complete save)
 * - partial incoming onto complete → content kept, only bookmark info filled
 * - partial onto partial → posts unioned
 */
export function mergeItem(existing: ItemDoc | ExtItem | null, incoming: ExtItem): MergeResult {
  if (!existing) return { item: finalize(incoming), changed: ['*'] };

  let merged: ExtItem;
  const base: ExtItem = pickExt(existing);
  if (!incoming.thread_complete && existing.thread_complete) {
    merged = { ...base };
  } else if (incoming.thread_complete) {
    // Union so nothing saved earlier is lost (e.g. a bookmarked post the page no longer shows).
    merged = { ...base, ...pickContent(incoming), posts: orderLike(unionPosts(base.posts, incoming.posts), incoming.posts) };
  } else {
    merged = { ...base, posts: unionPosts(base.posts, incoming.posts) };
  }

  merged.id = existing.id;
  merged.bookmarked_post_id = existing.bookmarked_post_id || incoming.bookmarked_post_id;
  merged.bookmarked_at = existing.bookmarked_at ?? incoming.bookmarked_at;
  merged.bookmark_sort_index = existing.bookmark_sort_index ?? incoming.bookmark_sort_index;
  if (merged.thread_complete) merged.type = merged.posts.length > 1 ? 'thread' : 'post';
  merged = finalize(merged);

  const changed: string[] = [];
  for (const k of Object.keys(merged) as (keyof ExtItem)[]) {
    if (k === 'id') continue;
    if (JSON.stringify(merged[k]) !== JSON.stringify((existing as ExtItem)[k] ?? null)) changed.push(k);
  }
  return { item: merged, changed };
}

/** Thread order from the reply chain; posts not in the chain go by time. */
function orderLike(posts: StoredPost[], chain: StoredPost[]): StoredPost[] {
  const idx = new Map(chain.map((p, i) => [p.id, i]));
  const inChain = posts.filter((p) => idx.has(p.id)).sort((a, b) => idx.get(a.id)! - idx.get(b.id)!);
  const rest = posts.filter((p) => !idx.has(p.id));
  if (rest.length === 0) return inChain;
  return [...inChain, ...rest].sort(byChrono);
}

const CONTENT_KEYS = [
  'type',
  'thread_complete',
  'author_name',
  'author_handle',
  'author_id',
  'url',
  'conversation_id',
  'capture_method',
] as const;

function pickContent(i: ExtItem): Partial<ExtItem> {
  const out: Partial<ExtItem> = {};
  for (const k of CONTENT_KEYS) (out as any)[k] = i[k];
  return out;
}

const EXT_KEYS: (keyof ExtItem)[] = [
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
];

export function pickExt(d: ItemDoc | ExtItem): ExtItem {
  const out: any = {};
  for (const k of EXT_KEYS) out[k] = (d as any)[k] ?? (k === 'posts' || k === 'match_ids' || k === 'search_tokens' ? [] : null);
  return out as ExtItem;
}

/** Item for a single bookmark seen on the bookmarks page. */
export function itemFromBookmark(p: ParsedPost, sortIndex: string | null, seenAt: string, captureMethod: 'graphql' | 'dom' = 'graphql'): ExtItem {
  const thread = looksLikeThread(p);
  // A self-reply's conversation root is almost always the start of the author's thread.
  const selfReply = !!p.in_reply_to_user_id && p.in_reply_to_user_id === p.author_id;
  const id = thread && selfReply && p.conversation_id ? p.conversation_id : p.id;
  return buildItem({
    id,
    posts: [p],
    author: { id: p.author_id, name: p.author_name, handle: p.author_handle },
    threadComplete: !thread,
    isThread: thread,
    bookmarkedPostId: p.id,
    bookmarkedAt: seenAt,
    bookmarkSortIndex: sortIndex,
    captureMethod,
    rootId: id,
  });
}

/** Item for a Flow 2 save from a post page. */
export function itemFromThread(t: AssembledThread, focalId: string, captureMethod: 'graphql' | 'dom'): ExtItem {
  const focal = t.posts.find((p) => p.id === focalId) ?? t.posts[0];
  return buildItem({
    id: t.rootId,
    posts: t.posts,
    author: { id: focal.author_id, name: focal.author_name, handle: focal.author_handle },
    threadComplete: t.topLoaded,
    isThread: t.posts.length > 1 || !t.topLoaded,
    bookmarkedPostId: focalId,
    bookmarkedAt: null,
    captureMethod,
    conversationId: focal.conversation_id,
    rootId: t.rootId,
  });
}

export const SIZE_WARN_BYTES = 900 * 1024;
export function approxSize(item: ExtItem): number {
  return new TextEncoder().encode(JSON.stringify(item)).length;
}
