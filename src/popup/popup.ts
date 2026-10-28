import type { PageState, StatusReply, ToBackground, ToContent } from '../shared/messages';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const bg = <T>(msg: ToBackground) => chrome.runtime.sendMessage(msg) as Promise<T>;

let tabId: number | undefined;
const toTab = <T>(msg: ToContent) => (tabId ? (chrome.tabs.sendMessage(tabId, msg) as Promise<T>) : Promise.reject(new Error('no tab')));

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function showError(e: unknown) {
  const el = $('error');
  el.hidden = !e;
  el.textContent = e ? (e instanceof Error ? e.message : String(e)) : '';
}

async function renderStatus() {
  const s = await bg<StatusReply>({ type: 'getStatus' });
  $('account').textContent = s.signedIn ? s.email ?? 'signed in' : 'signed out';
  $('auth').textContent = s.signedIn ? 'Sign out' : 'Sign in';
  $('pending').textContent = String(s.pending);
  $('total').textContent = String(s.total);
  $('incomplete').textContent = String(s.incomplete);
  $('last-sync').textContent = ago(s.lastSyncAt);
  $<HTMLButtonElement>('viewer').disabled = !s.viewerUrl;
  $('viewer').dataset.url = s.viewerUrl;
  if (s.pending > 0 && s.lastError) showError(`Last sync error: ${s.lastError}`);
  else if (s.pending > 0 && !s.signedIn) showError('Signed out: saves are kept locally until you sign in.');
  else showError(null);

  const ul = $('needs');
  ul.replaceChildren();
  if (s.needsThreadSave.length === 0) {
    ul.innerHTML = '<li class="muted">Nothing here.</li>';
  }
  for (const n of s.needsThreadSave) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = n.url;
    a.target = '_blank';
    const h = document.createElement('div');
    h.className = 'h';
    h.textContent = `@${n.author_handle}`;
    const p = document.createElement('div');
    p.className = 'p';
    p.textContent = n.preview;
    a.append(h, p);
    li.append(a);
    ul.append(li);
  }
}

async function renderPage() {
  const state = await toTab<PageState>({ type: 'getPageState' }).catch(() => null);
  const page = state?.page ?? 'other';
  $('sync').hidden = page !== 'bookmarks';
  $('stop').hidden = page !== 'bookmarks';
  $('save').hidden = page !== 'post';
  $<HTMLButtonElement>('sync').disabled = !!state?.sync.running;
  $<HTMLButtonElement>('stop').disabled = !state?.sync.running;
  const st = state?.sync;
  let text = '';
  if (page === 'bookmarks' && st) {
    if (st.running) text = `Syncing… ${st.scrolls} scrolls · ${st.saved} new · ${st.knownRun} already saved in a row`;
    else if (st.stoppedReason) text = `Last run: ${st.stoppedReason} · ${st.saved} new`;
    else text = `${state!.captures} responses captured on this page.`;
  } else if (!state) {
    text = 'Open x.com/i/bookmarks to sync, or a post to save its thread. (Reload X tabs opened before the extension was installed.)';
  }
  $('sync-state').textContent = text;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  $('sync').onclick = () => toTab({ type: 'startSync' }).then(renderPage);
  $('stop').onclick = () => toTab({ type: 'stopSync' }).then(renderPage);
  $('save').onclick = () => toTab({ type: 'saveThread' }).then(() => setTimeout(renderStatus, 500));
  $('viewer').onclick = () => chrome.tabs.create({ url: $('viewer').dataset.url });
  $('push').onclick = () => bg({ type: 'syncNow' }).then(renderStatus).catch(showError);
  $('auth').onclick = async () => {
    try {
      const s = await bg<StatusReply>({ type: 'getStatus' });
      const r = await bg<{ ok: boolean; error?: string }>({ type: s.signedIn ? 'signOut' : 'signIn' });
      if (!r.ok) throw new Error(r.error);
      await renderStatus();
    } catch (e) {
      showError(e);
    }
  };
  await Promise.all([renderStatus(), renderPage()]);
  setInterval(() => {
    void renderPage();
    void renderStatus();
  }, 1500);
}

void init();
