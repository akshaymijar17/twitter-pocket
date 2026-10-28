// Every assumption about X's internal GraphQL response shapes lives in this
// module. X changes these shapes without notice, so every access is defensive:
// unknown shapes are skipped, never thrown on.

import type { ParsedPost, ParseResult, QuotedPost, TimelineEntry } from './types';

type Json = any;

/** GraphQL operations we capture. Anything with "Bookmark" in its name is captured too. */
export const CAPTURED_OPERATIONS = [
  'Bookmarks',
  'BookmarkSearchTimeline',
  'BookmarkFolderTimeline',
  'TweetDetail',
  'TweetResultByRestId',
];

/** Pulls the operation name out of `/i/api/graphql/<queryId>/<OperationName>`. */
export function operationFromUrl(url: string): string | null {
  const m = /\/graphql\/[^/]+\/([A-Za-z0-9_]+)/.exec(url);
  return m ? m[1] : null;
}

export function isCapturedOperation(op: string | null): op is string {
  return !!op && (CAPTURED_OPERATIONS.includes(op) || /bookmark/i.test(op));
}

export function isBookmarksOperation(op: string): boolean {
  return /bookmark/i.test(op);
}

const SNOWFLAKE_EPOCH = 1288834974657n;

/** Post ids are snowflakes; the creation time is encoded in the high bits. */
export function timeFromSnowflake(id: string): string | null {
  try {
    const ms = (BigInt(id) >> 22n) + SNOWFLAKE_EPOCH;
    return new Date(Number(ms)).toISOString();
  } catch {
    return null;
  }
}

/** Numeric comparison for id strings without losing precision. */
export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseResponse(operation: string, json: Json): ParseResult {
  const posts = new Map<string, ParsedPost>();
  const entries: TimelineEntry[] = [];
  let sawCursor = false;

  const addResult = (result: Json, fallbackId: string | null) => {
    const post = parseTweetResult(result, fallbackId);
    if (!post) return null;
    const prev = posts.get(post.id);
    // Never let an unavailable copy replace a real one.
    if (!prev || (prev.unavailable && !post.unavailable)) posts.set(post.id, post);
    return post;
  };

  const handleItemContent = (itemContent: Json, entryId: string | null): ParsedPost | null => {
    if (!itemContent || typeof itemContent !== 'object') return null;
    const tr = itemContent.tweet_results ?? itemContent.tweetResult;
    if (tr) return addResult(tr.result, idFromEntryId(entryId));
    if (itemContent.cursorType || itemContent.__typename === 'TimelineTimelineCursor') sawCursor = true;
    return null;
  };

  for (const instructions of findInstructionLists(json)) {
    for (const ins of instructions) {
      const insEntries: Json[] = [];
      if (Array.isArray(ins?.entries)) insEntries.push(...ins.entries);
      if (ins?.entry) insEntries.push(ins.entry);
      for (const entry of insEntries) {
        const entryId: string | null = entry?.entryId ?? null;
        const content = entry?.content ?? {};
        if (content.cursorType || /^cursor-/.test(entryId ?? '')) {
          sawCursor = true;
          continue;
        }
        const ic = content.itemContent ?? content.content;
        if (ic) {
          const post = handleItemContent(ic, entryId);
          if (post && entryId && !/^(promoted|who-to-follow)/.test(entryId)) {
            entries.push({ entryId, postId: post.id, sortIndex: entry.sortIndex ?? null });
          }
        }
        // Conversation modules (TweetDetail threads, "Show more" chunks).
        if (Array.isArray(content.items)) {
          for (const it of content.items) {
            handleItemContent(it?.item?.itemContent ?? it?.item?.content, it?.entryId ?? null);
          }
        }
      }
      // "Show replies" / "Show more" appends to an existing module.
      if (Array.isArray(ins?.moduleItems)) {
        for (const it of ins.moduleItems) {
          handleItemContent(it?.item?.itemContent ?? it?.item?.content, it?.entryId ?? null);
        }
      }
    }
  }

  // Safety net for shapes the structured walk does not know about.
  deepCollectTweetResults(json, (res) => addResult(res, null));

  // TweetResultByRestId has no timeline; treat its single post as the entry.
  const direct = json?.data?.tweetResult?.result;
  if (direct && entries.length === 0) {
    const p = addResult(direct, null);
    if (p) entries.push({ entryId: `tweet-${p.id}`, postId: p.id, sortIndex: null });
  }

  return { operation, posts: [...posts.values()], entries, empty: entries.length === 0 && sawCursor };
}

function idFromEntryId(entryId: string | null): string | null {
  const m = /(?:^|-)(\d{5,})$/.exec(entryId ?? '');
  return m ? m[1] : null;
}

/** Finds every `instructions` array in the response, wherever X nested it. */
function findInstructionLists(json: Json): Json[][] {
  const out: Json[][] = [];
  const walk = (node: Json, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'instructions' && Array.isArray(v)) out.push(v);
      else if (k !== 'tweet_results' && k !== 'tweetResult') walk(v, depth + 1);
    }
  };
  walk(json, 0);
  return out;
}

function deepCollectTweetResults(json: Json, cb: (result: Json) => void) {
  const walk = (node: Json, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'tweet_results' && v && typeof v === 'object' && (v as Json).result) cb((v as Json).result);
      // Quoted / retweeted posts are handled by their parent.
      else if (k !== 'quoted_status_result' && k !== 'retweeted_status_result') walk(v, depth + 1);
    }
  };
  walk(json, 0);
}

/** Unwraps TweetWithVisibilityResults and similar wrappers. */
export function unwrapTweet(result: Json): Json {
  let r = result;
  for (let i = 0; i < 3 && r; i++) {
    if (r.__typename === 'TweetWithVisibilityResults' || (r.tweet && !r.legacy)) r = r.tweet;
    else break;
  }
  return r;
}

function unavailablePost(id: string): ParsedPost {
  return {
    id,
    author_id: null,
    author_name: null,
    author_handle: null,
    text: '[unavailable]',
    created_at: timeFromSnowflake(id),
    conversation_id: null,
    in_reply_to_status_id: null,
    in_reply_to_user_id: null,
    media: [],
    quoted: null,
    unavailable: true,
    self_thread_id: null,
    long: false,
  };
}

export function parseTweetResult(result: Json, fallbackId: string | null = null): ParsedPost | null {
  const t = unwrapTweet(result);
  if (!t || typeof t !== 'object') return fallbackId ? unavailablePost(fallbackId) : null;
  const legacy = t.legacy;
  const id: string | null = t.rest_id ?? legacy?.id_str ?? fallbackId;
  if (t.__typename === 'TweetTombstone' || t.__typename === 'TweetUnavailable' || !legacy) {
    return id ? unavailablePost(id) : null;
  }
  if (!id) return null;

  const author = parseAuthor(t);
  const { text, long } = extractText(t);
  return {
    id,
    author_id: author.id ?? legacy.user_id_str ?? null,
    author_name: author.name,
    author_handle: author.handle,
    text,
    created_at: parseDate(legacy.created_at) ?? timeFromSnowflake(id),
    conversation_id: legacy.conversation_id_str ?? null,
    in_reply_to_status_id: legacy.in_reply_to_status_id_str ?? null,
    in_reply_to_user_id: legacy.in_reply_to_user_id_str ?? null,
    media: extractMedia(legacy),
    quoted: extractQuoted(t),
    unavailable: false,
    self_thread_id: legacy.self_thread?.id_str ?? null,
    long,
  };
}

function parseAuthor(t: Json): { id: string | null; name: string | null; handle: string | null } {
  const u = unwrapUser(t.core?.user_results?.result);
  if (!u) return { id: null, name: null, handle: null };
  return {
    id: u.rest_id ?? u.id_str ?? null,
    handle: u.legacy?.screen_name ?? u.core?.screen_name ?? null,
    name: u.legacy?.name ?? u.core?.name ?? null,
  };
}

function unwrapUser(u: Json): Json {
  if (u && u.__typename === 'UserUnavailable') return null;
  return u ?? null;
}

function parseDate(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

/** Full text: note_tweet for long posts, else legacy.full_text; t.co links expanded. */
export function extractText(t: Json): { text: string; long: boolean } {
  const legacy = t.legacy ?? {};
  const note = t.note_tweet?.note_tweet_results?.result;
  const mediaUrls = new Set<string>(
    [...(legacy.entities?.media ?? []), ...(legacy.extended_entities?.media ?? [])]
      .map((m: Json) => m?.url)
      .filter(Boolean),
  );
  const quoteUrl: string | null = legacy.quoted_status_permalink?.url ?? null;

  let text: string;
  let urls: Json[];
  let long = false;
  if (note && typeof note.text === 'string' && note.text.length > 0) {
    text = note.text;
    urls = note.entity_set?.urls ?? legacy.entities?.urls ?? [];
    long = true;
  } else {
    text = stripLeadingMentions(String(legacy.full_text ?? ''), legacy.display_text_range);
    urls = legacy.entities?.urls ?? [];
  }

  // Remove media links, and the quote permalink (the quote is stored separately).
  for (const u of mediaUrls) text = text.split(u).join('');
  if (quoteUrl) text = stripTrailing(text, quoteUrl);
  for (const u of urls) {
    if (u?.url && u?.expanded_url) {
      if (quoteUrl && u.url === quoteUrl) continue;
      text = text.split(u.url).join(u.expanded_url);
    }
  }
  if (!long) text = decodeEntities(text);
  if (mediaUrls.size) text = text.replace(/[ \t]{2,}/g, ' ');
  return { text: text.trim(), long };
}

function stripTrailing(text: string, s: string): string {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(s) ? trimmed.slice(0, -s.length) : text;
}

/** Drops the auto-inserted "@a @b " reply prefix (outside display_text_range). */
function stripLeadingMentions(text: string, range: unknown): string {
  if (!Array.isArray(range) || typeof range[0] !== 'number' || range[0] <= 0) return text;
  const cps = Array.from(text);
  const prefix = cps.slice(0, range[0]).join('');
  if (/^(\s*@\w{1,15})+\s*$/.test(prefix)) return cps.slice(range[0]).join('');
  return text;
}

export function extractMedia(legacy: Json): string[] {
  const media: Json[] = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
  const out: string[] = [];
  for (const m of media) {
    if (!m) continue;
    if ((m.type === 'video' || m.type === 'animated_gif') && Array.isArray(m.video_info?.variants)) {
      const mp4s = m.video_info.variants.filter((v: Json) => v?.content_type === 'video/mp4' && v.url);
      mp4s.sort((a: Json, b: Json) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      if (mp4s[0]) {
        out.push(mp4s[0].url);
        continue;
      }
    }
    if (m.media_url_https) out.push(m.media_url_https);
  }
  return [...new Set(out)];
}

function extractQuoted(t: Json): QuotedPost | null {
  const qr = t.quoted_status_result?.result;
  const quotedId: string | null = t.legacy?.quoted_status_id_str ?? null;
  if (!qr) {
    if (!quotedId) return null;
    return { id: quotedId, author_handle: null, text: '[unavailable]', url: `https://x.com/i/status/${quotedId}`, unavailable: true };
  }
  const p = parseTweetResult(qr, quotedId);
  if (!p) return null;
  return {
    id: p.id,
    author_handle: p.author_handle,
    text: p.text,
    url: postUrl(p.author_handle, p.id),
    ...(p.unavailable ? { unavailable: true } : {}),
  };
}

export function postUrl(handle: string | null, id: string): string {
  return `https://x.com/${handle ?? 'i'}/status/${id}`;
}
