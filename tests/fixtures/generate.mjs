// Generates synthetic fixtures that follow the shape of X's GraphQL responses
// (as of late 2026). Replace or add to them with real captures from the
// extension's debug download (Downloads/x-bookmarks-debug/), and keep the tests
// passing. Run: node tests/fixtures/generate.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const users = {
  naval: { rest_id: '745273', name: 'Naval', screen_name: 'naval', newShape: false },
  alice: { rest_id: '1001', name: 'Alice Ng', screen_name: 'alice', newShape: true },
  bob: { rest_id: '1002', name: 'Bob', screen_name: 'bob', newShape: false },
};

function user(u) {
  // X has moved name/screen_name from .legacy to .core; fixtures exercise both.
  return u.newShape
    ? { __typename: 'User', rest_id: u.rest_id, core: { name: u.name, screen_name: u.screen_name }, legacy: { followers_count: 1 } }
    : { __typename: 'User', rest_id: u.rest_id, legacy: { name: u.name, screen_name: u.screen_name } };
}

function tweet(id, u, text, extra = {}) {
  const { legacy: legacyExtra = {}, wrap, note, quoted, ...rest } = extra;
  const t = {
    __typename: 'Tweet',
    rest_id: id,
    core: { user_results: { result: user(u) } },
    legacy: {
      id_str: id,
      user_id_str: u.rest_id,
      created_at: legacyExtra.created_at ?? 'Wed Oct 01 12:00:00 +0000 2025',
      full_text: text,
      conversation_id_str: legacyExtra.conversation_id_str ?? id,
      display_text_range: [0, Array.from(text).length],
      entities: { urls: [], hashtags: [], user_mentions: [] },
      ...legacyExtra,
    },
    ...rest,
  };
  if (note) t.note_tweet = { is_expandable: true, note_tweet_results: { result: { id: 'note' + id, text: note.text, entity_set: { urls: note.urls ?? [] } } } };
  if (quoted) t.quoted_status_result = { result: quoted };
  return wrap ? { __typename: 'TweetWithVisibilityResults', tweet: t, limitedActionResults: { limited_actions: [] } } : t;
}

const item = (entryId, result, sortIndex) => ({
  entryId,
  sortIndex,
  content: {
    entryType: 'TimelineTimelineItem',
    __typename: 'TimelineTimelineItem',
    itemContent: { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result } },
  },
});
const moduleEntry = (entryId, results) => ({
  entryId,
  sortIndex: '0',
  content: {
    entryType: 'TimelineTimelineModule',
    __typename: 'TimelineTimelineModule',
    displayType: 'VerticalConversation',
    items: results.map(([id, r]) => ({
      entryId: `${entryId}-tweet-${id}`,
      item: { itemContent: { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result: r } } },
    })),
  },
});
const cursor = (v, type = 'Bottom') => ({
  entryId: `cursor-${type.toLowerCase()}-${v}`,
  sortIndex: '1',
  content: { entryType: 'TimelineTimelineCursor', __typename: 'TimelineTimelineCursor', value: v, cursorType: type },
});

const bookmarks = (entries) => ({
  data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } },
});
const detail = (instructions) => ({ data: { threaded_conversation_with_injections_v2: { instructions } } });

const LONG = 'This is a long post. '.repeat(30) + 'Read more at https://t.co/long1 — the end.';
const fixtures = {
  // Normal post, long post (note_tweet), quote post, a self-reply in a thread,
  // a tombstone, and a post wrapped in TweetWithVisibilityResults.
  'bookmarks-page1.json': bookmarks([
    item('tweet-1845000000000000100', tweet('1845000000000000100', users.naval, 'Seek wealth, not money or status. https://t.co/abc123 https://t.co/media1 &amp; more', {
      legacy: {
        entities: { urls: [{ url: 'https://t.co/abc123', expanded_url: 'https://nav.al/wealth', display_url: 'nav.al/wealth' }], media: [{ url: 'https://t.co/media1' }] },
        extended_entities: {
          media: [
            { type: 'photo', url: 'https://t.co/media1', media_url_https: 'https://pbs.twimg.com/media/AAA.jpg' },
            { type: 'video', url: 'https://t.co/media1', media_url_https: 'https://pbs.twimg.com/thumb.jpg', video_info: { variants: [
              { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/pl.m3u8' },
              { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/low.mp4' },
              { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/high.mp4' },
            ] } },
          ],
        },
      },
    }), '1900000000000000300'),
    item('tweet-1845000000000000200', tweet('1845000000000000200', users.alice, 'Short version that X truncates…', {
      note: { text: LONG, urls: [{ url: 'https://t.co/long1', expanded_url: 'https://example.com/long' }] },
    }), '1900000000000000290'),
    item('tweet-1845000000000000300', tweet('1845000000000000300', users.bob, 'This is exactly right https://t.co/q1', {
      legacy: { quoted_status_id_str: '1845000000000000100', quoted_status_permalink: { url: 'https://t.co/q1', expanded: 'https://twitter.com/naval/status/1845000000000000100' }, entities: { urls: [{ url: 'https://t.co/q1', expanded_url: 'https://twitter.com/naval/status/1845000000000000100' }] } },
      quoted: tweet('1845000000000000100', users.naval, 'Seek wealth, not money or status.'),
    }), '1900000000000000280'),
    item('tweet-1845000000000000502', tweet('1845000000000000502', users.naval, '@naval 2/ Second point of the thread.', {
      wrap: true,
      legacy: { conversation_id_str: '1845000000000000500', in_reply_to_status_id_str: '1845000000000000501', in_reply_to_user_id_str: users.naval.rest_id, display_text_range: [7, 37] },
    }), '1900000000000000270'),
    item('tweet-1845000000000000999', { __typename: 'TweetTombstone', tombstone: { text: { text: 'This post was deleted by the Post author.' } } }, '1900000000000000260'),
    cursor('DAABCgABGc', 'Top'),
    cursor('DAABCgABGd', 'Bottom'),
  ]),
  'bookmarks-empty.json': bookmarks([cursor('x', 'Top'), cursor('y', 'Bottom')]),

  // Thread page focused on post 502 (the middle of a self-thread by naval), with
  // ancestors, descendants, a reply by another author, and the author answering
  // that reply (which must not be included).
  'tweetdetail-thread.json': detail([
    { type: 'TimelineClearCache' },
    {
      type: 'TimelineAddEntries',
      entries: [
        item('tweet-1845000000000000500', tweet('1845000000000000500', users.naval, 'How to get rich (without getting lucky): 🧵', { legacy: { created_at: 'Wed Oct 01 10:00:00 +0000 2025' } }), '9'),
        item('tweet-1845000000000000501', tweet('1845000000000000501', users.naval, '@naval 1/ First point.', {
          legacy: { created_at: 'Wed Oct 01 10:01:00 +0000 2025', conversation_id_str: '1845000000000000500', in_reply_to_status_id_str: '1845000000000000500', in_reply_to_user_id_str: users.naval.rest_id, display_text_range: [7, 22] },
        }), '8'),
        item('tweet-1845000000000000502', tweet('1845000000000000502', users.naval, '@naval 2/ Second point of the thread.', {
          wrap: true,
          legacy: { created_at: 'Wed Oct 01 10:02:00 +0000 2025', conversation_id_str: '1845000000000000500', in_reply_to_status_id_str: '1845000000000000501', in_reply_to_user_id_str: users.naval.rest_id, display_text_range: [7, 37] },
        }), '7'),
        moduleEntry('conversationthread-1845000000000000503', [
          ['1845000000000000503', tweet('1845000000000000503', users.naval, '@naval 3/ Third point.', {
            legacy: { created_at: 'Wed Oct 01 10:03:00 +0000 2025', conversation_id_str: '1845000000000000500', in_reply_to_status_id_str: '1845000000000000502', in_reply_to_user_id_str: users.naval.rest_id, display_text_range: [7, 22] },
          })],
          ['1845000000000000504', tweet('1845000000000000504', users.naval, '@naval 4/ Fourth point.', {
            legacy: { created_at: 'Wed Oct 01 10:04:00 +0000 2025', conversation_id_str: '1845000000000000500', in_reply_to_status_id_str: '1845000000000000503', in_reply_to_user_id_str: users.naval.rest_id, display_text_range: [7, 23] },
          })],
        ]),
        moduleEntry('conversationthread-1845000000000000600', [
          ['1845000000000000600', tweet('1845000000000000600', users.bob, '@naval Great thread!', {
            legacy: { created_at: 'Wed Oct 01 10:05:00 +0000 2025', conversation_id_str: '1845000000000000500', in_reply_to_status_id_str: '1845000000000000502', in_reply_to_user_id_str: users.naval.rest_id, display_text_range: [7, 20] },
          })],
          ['1845000000000000601', tweet('1845000000000000601', users.naval, '@bob Thanks!', {
            legacy: { created_at: 'Wed Oct 01 10:06:00 +0000 2025', conversation_id_str: '1845000000000000500', in_reply_to_status_id_str: '1845000000000000600', in_reply_to_user_id_str: users.bob.rest_id, display_text_range: [5, 12] },
          })],
        ]),
        cursor('more', 'Bottom'),
      ],
    },
  ]),
  // A later "Show more" request that appends the last post via TimelineAddToModule.
  'tweetdetail-showmore.json': detail([
    {
      type: 'TimelineAddToModule',
      moduleEntryId: 'conversationthread-1845000000000000503',
      moduleItems: [
        { entryId: 'conversationthread-1845000000000000503-tweet-1845000000000000505', item: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweet('1845000000000000505', users.naval, '@naval 5/ Last point.', {
          legacy: { created_at: 'Wed Oct 01 10:07:00 +0000 2025', conversation_id_str: '1845000000000000500', in_reply_to_status_id_str: '1845000000000000504', in_reply_to_user_id_str: users.naval.rest_id, display_text_range: [7, 21] },
        }) } } } },
      ],
    },
  ]),
  // Thread whose second post was deleted.
  'tweetdetail-tombstone.json': detail([
    {
      type: 'TimelineAddEntries',
      entries: [
        item('tweet-1845000000000000700', tweet('1845000000000000700', users.alice, 'Thread start', { legacy: { created_at: 'Thu Oct 02 10:00:00 +0000 2025' } }), '3'),
        item('tweet-1845000000000000701', { __typename: 'TweetTombstone', tombstone: {} }, '2'),
        item('tweet-1845000000000000702', tweet('1845000000000000702', users.alice, 'Third (second was deleted)', {
          legacy: { created_at: 'Thu Oct 02 10:02:00 +0000 2025', conversation_id_str: '1845000000000000700', in_reply_to_status_id_str: '1845000000000000701', in_reply_to_user_id_str: users.alice.rest_id },
        }), '1'),
      ],
    },
  ]),
};

for (const [name, json] of Object.entries(fixtures)) {
  writeFileSync(join(here, name), JSON.stringify(json, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(fixtures).length} fixtures`);
