import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shared with the viewer
import { itemFilename, itemToMarkdown } from '../viewer/markdown.js';
import { parseResponse } from '../src/shared/parser';
import { assembleThread, itemFromThread } from '../src/shared/thread';

describe('markdown export', () => {
  const posts = parseResponse('TweetDetail', JSON.parse(readFileSync(join(__dirname, 'fixtures', 'tweetdetail-thread.json'), 'utf8'))).posts;
  const item = { ...itemFromThread(assembleThread(new Map(posts.map((p) => [p.id, p])), '1845000000000000502')!, '1845000000000000502', 'graphql'), status: 'read', tags: ['wealth'] };

  it('numbers thread posts and includes front matter', () => {
    const md = itemToMarkdown(item);
    expect(md).toContain('# Thread by Naval (@naval)');
    expect(md).toContain('## 1/5');
    expect(md).toContain('## 5/5\n\n4/ Fourth point.');
    expect(md).toContain('tags: ["wealth"]');
    expect(md).toContain('[Open on X](https://x.com/naval/status/1845000000000000500)');
    expect(itemFilename(item)).toBe('2025-10-01-naval-1845000000000000500.md');
  });

  it('renders quotes and media', () => {
    const md = itemToMarkdown({
      ...item,
      type: 'post',
      posts: [{ id: '1', text: 'hi', created_at: null, media: ['https://pbs.twimg.com/a.jpg'], quoted: { id: '2', author_handle: 'bob', text: 'line1\nline2', url: 'https://x.com/bob/status/2' }, unavailable: false }],
    });
    expect(md).toContain('> Quoting @bob (https://x.com/bob/status/2):\n>\n> line1\n> line2');
    expect(md).toContain('- https://pbs.twimg.com/a.jpg');
    expect(md).not.toContain('## 1/1');
  });
});
