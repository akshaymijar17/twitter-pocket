// Fallback reader for when no GraphQL response was captured (e.g. the page
// loaded before the hook was in place). Reads the rendered posts, so long
// posts may be cut off at X's "Show more".

import type { ParsedPost } from '../shared/types';

export function readArticles(root: ParentNode = document): ParsedPost[] {
  const out: ParsedPost[] = [];
  for (const article of root.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
    const p = readArticle(article);
    if (p && !out.some((o) => o.id === p.id)) out.push(p);
  }
  return out;
}

function readArticle(article: HTMLElement): ParsedPost | null {
  const time = article.querySelector('time');
  const link = time?.closest<HTMLAnchorElement>('a[href*="/status/"]');
  const m = /^\/([^/]+)\/status\/(\d+)/.exec(link?.getAttribute('href') ?? '');
  if (!m) return null;
  const [, handle, id] = m;
  const nameEl = article.querySelector('[data-testid="User-Name"] span');
  // The first tweetText not inside a quoted post (quotes render inside a role=link block).
  const texts = [...article.querySelectorAll<HTMLElement>('[data-testid="tweetText"]')];
  const own = texts.find((t) => !t.closest('div[role="link"]')) ?? null;
  const quoteText = texts.find((t) => t !== own && t.closest('div[role="link"]'));
  const media = [...article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]')]
    .filter((img) => !img.closest('div[role="link"]'))
    .map((img) => img.src.replace(/name=\w+/, 'name=large'));
  return {
    id,
    author_id: `@${handle.toLowerCase()}`,
    author_name: nameEl?.textContent?.trim() || handle,
    author_handle: handle,
    text: own?.innerText?.trim() ?? '',
    created_at: time?.getAttribute('datetime') ?? null,
    conversation_id: null,
    in_reply_to_status_id: null,
    in_reply_to_user_id: null,
    media: [...new Set(media)],
    quoted: quoteText ? { id: '', author_handle: null, text: quoteText.innerText.trim(), url: '' } : null,
    unavailable: false,
    self_thread_id: null,
    long: false,
    from_dom: true,
  };
}

/** The contiguous run of same-author posts around the focal one, in page order. */
export function domThread(posts: ParsedPost[], focalId: string): ParsedPost[] | null {
  const i = posts.findIndex((p) => p.id === focalId);
  if (i < 0) return null;
  const author = posts[i].author_id;
  let start = i;
  let end = i;
  while (start > 0 && posts[start - 1].author_id === author) start--;
  while (end < posts.length - 1 && posts[end + 1].author_id === author) end++;
  return posts.slice(start, end + 1);
}
