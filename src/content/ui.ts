// Toast and the injected "Save" button, isolated from X's styles in a shadow root.

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;

function root(): ShadowRoot {
  if (shadow && host?.isConnected) return shadow;
  host = document.createElement('x-bookmarks-saver');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 20px; bottom: 20px;';
  shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { font-family: -apple-system, 'IBM Plex Sans', sans-serif; font-size: 13px; }
      .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
      .toast { background: #000; color: #fff; padding: 10px 14px; max-width: 360px; line-height: 1.4;
               border-radius: 4px; opacity: 0; transform: translateY(6px); transition: opacity .2s, transform .2s; }
      .toast.show { opacity: 1; transform: none; }
      .toast.error { background: #b00020; }
      button { font: inherit; background: #fff; color: #000; border: 1px solid #000; padding: 6px 12px;
               border-radius: 4px; cursor: pointer; }
      button:hover { background: #000; color: #fff; }
      button[hidden] { display: none; }
    </style>
    <div class="wrap"><div class="toast" role="status" aria-live="polite"></div>
    <button type="button" hidden title="Save this post and its thread (Alt+Shift+S)">Save thread</button></div>`;
  (document.body ?? document.documentElement).appendChild(host);
  return shadow;
}

let hideTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(text: string, error = false) {
  const t = root().querySelector<HTMLElement>('.toast')!;
  t.textContent = text;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => t.classList.remove('show'), error ? 6000 : 3500);
}

export function syncPageButton(visible: boolean, onClick: () => void) {
  if (!visible && !host) return;
  const b = root().querySelector<HTMLButtonElement>('button')!;
  b.hidden = !visible;
  b.onclick = onClick;
}
