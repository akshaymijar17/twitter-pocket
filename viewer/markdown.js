// Markdown export. Items here are plain objects with ISO-string timestamps.

const yaml = (v) => (v === null || v === undefined ? '' : JSON.stringify(v));

export function itemFilename(item) {
  const date = (item.created_at || '').slice(0, 10) || 'undated';
  const handle = (item.author_handle || 'unknown').replace(/[^\w-]/g, '');
  return `${date}-${handle}-${item.id}.md`;
}

export function itemToMarkdown(item) {
  const posts = item.posts || [];
  const lines = [
    '---',
    `id: ${yaml(item.id)}`,
    `url: ${yaml(item.url)}`,
    `author: ${yaml(item.author_name)}`,
    `handle: ${yaml(item.author_handle)}`,
    `type: ${yaml(item.type)}`,
    `thread_complete: ${item.thread_complete ? 'true' : 'false'}`,
    `post_count: ${posts.length}`,
    `created_at: ${yaml(item.created_at)}`,
    `bookmarked_at: ${yaml(item.bookmarked_at)}`,
    `status: ${yaml(item.status || 'unread')}`,
    `favorite: ${item.favorite ? 'true' : 'false'}`,
    `tags: ${JSON.stringify(item.tags || [])}`,
    '---',
    '',
    `# ${item.type === 'thread' ? 'Thread' : 'Post'} by ${item.author_name} (@${item.author_handle})`,
    '',
    `[Open on X](${item.url})${item.created_at ? ` · ${item.created_at.slice(0, 10)}` : ''}${item.thread_complete ? '' : ' · *incomplete thread*'}`,
    '',
  ];
  posts.forEach((p, i) => {
    if (posts.length > 1) lines.push(`## ${i + 1}/${posts.length}`, '');
    lines.push(p.unavailable ? '*[unavailable]*' : p.text, '');
    if (p.quoted) {
      const q = p.quoted;
      lines.push(...`Quoting ${q.author_handle ? '@' + q.author_handle : 'a post'}${q.url ? ` (${q.url})` : ''}:\n\n${q.text}`.split('\n').map((l) => `> ${l}`.trimEnd()), '');
    }
    for (const m of p.media || []) lines.push(`- ${m}`);
    if ((p.media || []).length) lines.push('');
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
