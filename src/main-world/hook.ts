// Runs in the page's own JS context (world: MAIN) at document_start, before X's
// code, and wraps fetch/XHR to copy X's GraphQL responses. It only reads
// responses; requests are passed through untouched.

import { HOOK_TAG, type HookMessage } from '../shared/messages';
import { isCapturedOperation, operationFromUrl } from '../shared/parser';

(() => {
  const w = window as any;
  if (w[HOOK_TAG]) return;
  w[HOOK_TAG] = true;

  const forward = (url: string, json: unknown) => {
    const op = operationFromUrl(url);
    if (!isCapturedOperation(op)) return;
    const msg: HookMessage = { source: HOOK_TAG, op, url, json };
    window.postMessage(msg, location.origin);
  };
  const wanted = (url: string) => url.includes('/graphql/') && isCapturedOperation(operationFromUrl(url));

  const origFetch = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(window, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (wanted(url)) {
        res
          .clone()
          .json()
          .then((j) => forward(url, j))
          .catch(() => {});
      }
    } catch {
      /* never break the page */
    }
    return res;
  } as typeof fetch;

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __xbsUrl?: string }, ...args: any[]) {
    try {
      this.__xbsUrl = String(args[1]);
      if (wanted(this.__xbsUrl)) {
        this.addEventListener('load', () => {
          try {
            const rt = this.responseType;
            const json = rt === 'json' ? this.response : rt === '' || rt === 'text' ? JSON.parse(this.responseText) : null;
            if (json) forward(this.__xbsUrl!, json);
          } catch {
            /* not JSON */
          }
        });
      }
    } catch {
      /* never break the page */
    }
    return (origOpen as any).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
})();
