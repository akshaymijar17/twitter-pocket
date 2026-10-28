import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCapturedOperation, operationFromUrl, parseResponse, timeFromSnowflake } from '../src/shared/parser';
import { assembleThread, itemFromBookmark, itemFromThread, looksLikeThread } from '../src/shared/thread';
import type { ParsedPost } from '../src/shared/types';

const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const byId = (posts: ParsedPost[]) => new Map(posts.map((p) => [p.id, p]));

describe('operation matching', () => {
  it('extracts the operation from GraphQL URLs', () => {
    expect(operationFromUrl('https://x.com/i/api/graphql/abc-123_X/Bookmarks?variables=%7B%7D')).toBe('Bookmarks');
    expect(operationFromUrl('https://x.com/i/api/graphql/q/TweetDetail')).toBe('TweetDetail');
    expect(operationFromUrl('https://x.com/i/api/1.1/jot')).toBeNull();
  });
  it('captures bookmark variants and thread pages only', () => {
    expect(isCapturedOperation('Bookmarks')).toBe(true);
    expect(isCapturedOperation('BookmarkSearchTimeline')).toBe(true);
    expect(isCapturedOperation('TweetDetail')).toBe(true);
    expect(isCapturedOperation('HomeTimeline')).toBe(false);
  });
});

describe('bookmarks page parsing', () => {
  const res = parseResponse('Bookmarks', fx('bookmarks-page1.json'));
  const posts = byId(res.posts);

  it('returns entries in bookmark order, with sort indexes, tombstones included', () => {
    expect(res.entries.map((e) => e.postId)).toEqual([
      '1845000000000000100',
      '1845000000000000200',
      '1845000000000000300',
      '1845000000000000502',
      '1845000000000000999',
    ]);
    expect(res.entries[0].sortIndex).toBe('1900000000000000300');
    expect(res.empty).toBe(false);
  });

  it('normal post: expands t.co links, strips the media link, decodes entities, picks the best mp4', () => {
    const p = posts.get('1845000000000000100')!;
    expect(p.text).toBe('Seek wealth, not money or status. https://nav.al/wealth & more');
    expect(p.text).not.toContain('t.co');
    expect(p.author_handle).toBe('naval');
    expect(p.author_name).toBe('Naval');
    expect(p.created_at).toBe('2025-10-01T12:00:00.000Z');
    expect(p.media).toEqual(['https://pbs.twimg.com/media/AAA.jpg', 'https://video.twimg.com/high.mp4']);
    expect(looksLikeThread(p)).toBe(false);
  });

  it('long post: uses note_tweet text and its own entity set; reads author from .core', () => {
    const p = posts.get('1845000000000000200')!;
    expect(p.long).toBe(true);
    expect(p.text.length).toBeGreaterThan(600);
    expect(p.text).toContain('https://example.com/long');
    expect(p.text).not.toContain('truncates');
    expect(p.author_handle).toBe('alice');
    expect(p.author_name).toBe('Alice Ng');
  });

  it('quote post: captures the quoted post and drops the trailing permalink', () => {
    const p = posts.get('1845000000000000300')!;
    expect(p.text).toBe('This is exactly right');
    expect(p.quoted).toEqual({
      id: '1845000000000000100',
      author_handle: 'naval',
      text: 'Seek wealth, not money or status.',
      url: 'https://x.com/naval/status/1845000000000000100',
    });
  });

  it('self-reply wrapped in TweetWithVisibilityResults: unwrapped, reply mention stripped, flagged as thread', () => {
    const p = posts.get('1845000000000000502')!;
    expect(p.text).toBe('2/ Second point of the thread.');
    expect(p.conversation_id).toBe('1845000000000000500');
    expect(looksLikeThread(p)).toBe(true);
    const item = itemFromBookmark(p, '1', '2026-01-01T00:00:00.000Z');
    expect(item.thread_complete).toBe(false);
    expect(item.type).toBe('thread');
    expect(item.id).toBe('1845000000000000500'); // conversation root
    expect(item.bookmarked_post_id).toBe('1845000000000000502');
    expect(item.match_ids).toEqual(['1845000000000000500', '1845000000000000502']);
  });

  it('tombstone: recorded as [unavailable] with time from the snowflake id', () => {
    const p = posts.get('1845000000000000999')!;
    expect(p.unavailable).toBe(true);
    expect(p.text).toBe('[unavailable]');
    expect(p.created_at).toBe(timeFromSnowflake('1845000000000000999'));
  });

  it('end of list: only cursors', () => {
    const r = parseResponse('Bookmarks', fx('bookmarks-empty.json'));
    expect(r.entries).toEqual([]);
    expect(r.empty).toBe(true);
  });

  it('survives garbage', () => {
    expect(parseResponse('Bookmarks', null).posts).toEqual([]);
    expect(parseResponse('Bookmarks', { data: { x: [1, 'a', { instructions: [null, { entries: [null, {}] }] }] } }).posts).toEqual([]);
  });
});

describe('thread assembly', () => {
  const cache = byId(parseResponse('TweetDetail', fx('tweetdetail-thread.json')).posts);

  it('self-thread: ancestors + focal + descendants, in order, without other people', () => {
    const t = assembleThread(cache, '1845000000000000502')!;
    expect(t.posts.map((p) => p.id.slice(-3))).toEqual(['500', '501', '502', '503', '504']);
    expect(t.rootId).toBe('1845000000000000500');
    expect(t.topLoaded).toBe(true);
    // Bob's reply and naval's answer to Bob are excluded.
    expect(t.posts.some((p) => p.author_handle === 'bob' || p.id.endsWith('601'))).toBe(false);
  });

  it('accumulates across "show more" responses', () => {
    const more = parseResponse('TweetDetail', fx('tweetdetail-showmore.json'));
    const all = new Map(cache);
    for (const p of more.posts) all.set(p.id, p);
    const t = assembleThread(all, '1845000000000000502')!;
    expect(t.posts.map((p) => p.id.slice(-3))).toEqual(['500', '501', '502', '503', '504', '505']);
    const item = itemFromThread(t, '1845000000000000502', 'graphql');
    expect(item.id).toBe('1845000000000000500');
    expect(item.type).toBe('thread');
    expect(item.thread_complete).toBe(true);
    expect(item.post_count).toBe(6);
    expect(item.bookmarked_post_id).toBe('1845000000000000502');
    expect(item.url).toBe('https://x.com/naval/status/1845000000000000500');
    expect(item.search_tokens).toContain('fourth');
    expect(item.search_text).toContain('third point');
  });

  it('marks the thread incomplete when the top is not loaded', () => {
    const partial = new Map([...cache].filter(([id]) => !id.endsWith('500')));
    const t = assembleThread(partial, '1845000000000000502')!;
    expect(t.topLoaded).toBe(false);
    expect(t.posts[0].id.endsWith('501')).toBe(true);
  });

  it('tombstone in the middle: kept as [unavailable] and bridged to the root', () => {
    const c = byId(parseResponse('TweetDetail', fx('tweetdetail-tombstone.json')).posts);
    const t = assembleThread(c, '1845000000000000702')!;
    expect(t.posts.map((p) => [p.id.slice(-3), p.unavailable])).toEqual([
      ['700', false],
      ['701', true],
      ['702', false],
    ]);
    expect(t.topLoaded).toBe(true);
  });

  it('a single, non-thread post page gives a one-post item', () => {
    const t = assembleThread(cache, '1845000000000000601')!;
    // naval's reply to bob: parent is bob's post, so no ancestors; no same-author children.
    expect(t.posts.map((p) => p.id.slice(-3))).toEqual(['601']);
    expect(itemFromThread(t, t.rootId, 'graphql').type).toBe('post');
  });
});
