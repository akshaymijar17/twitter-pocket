// X bookmarks viewer: reads users/{uid}/x_items written by the extension.
// Only status / favorite / tags are ever written from here.

import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  initializeFirestore,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import JSZip from 'jszip';
import { itemFilename, itemToMarkdown } from '../markdown.js';

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
// Persistent cache: reloads only fetch what changed, and search runs over this local copy.
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  // Post text is untrusted: only ever inserted as text nodes.
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
};

const state = {
  user: null,
  items: new Map(),
  serverHits: null, // ids from the array-contains search_tokens query
  q: '',
  sort: 'bookmarked',
  status: 'unread',
  type: 'all',
  author: '',
  favorite: false,
  incomplete: false,
  unsub: null,
};

// ── Data ───────────────────────────────────────────────────────────────────

function plain(v) {
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

const itemsCol = () => collection(db, 'users', state.user.uid, 'x_items');

function subscribe() {
  state.unsub?.();
  state.unsub = onSnapshot(
    itemsCol(),
    (snap) => {
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') state.items.delete(ch.doc.id);
        else if (ch.doc.id !== 'test') state.items.set(ch.doc.id, { ...plain(ch.doc.data()), id: ch.doc.id });
      }
      $('#sync-note').textContent = snap.metadata.fromCache ? 'offline copy' : '';
      render();
    },
    (err) => showError(err),
  );
}

async function patch(id, fields) {
  const it = state.items.get(id);
  if (it) Object.assign(it, fields);
  render();
  try {
    await updateDoc(doc(db, 'users', state.user.uid, 'x_items', id), fields);
  } catch (e) {
    showError(e);
  }
}

let searchSeq = 0;
async function serverSearch(word) {
  const seq = ++searchSeq;
  try {
    const snap = await getDocs(query(itemsCol(), where('search_tokens', 'array-contains', word)));
    if (seq !== searchSeq) return;
    state.serverHits = new Set(snap.docs.map((d) => d.id));
    for (const d of snap.docs) if (!state.items.has(d.id)) state.items.set(d.id, { ...plain(d.data()), id: d.id });
    render();
  } catch (e) {
    console.warn('server search failed', e);
  }
}

// ── Filtering & sorting ────────────────────────────────────────────────────

const SNOWFLAKE_EPOCH = 1288834974657n;
/** X's bookmark sortIndex is time-ordered; when it decodes to a sane date it beats our "first seen" time. */
function bookmarkTime(it) {
  if (it.bookmark_sort_index && /^\d{15,20}$/.test(it.bookmark_sort_index)) {
    try {
      const ms = Number((BigInt(it.bookmark_sort_index) >> 22n) + SNOWFLAKE_EPOCH);
      if (ms > Date.UTC(2010, 0) && ms < Date.now() + 86400000) return ms;
    } catch {}
  }
  return Date.parse(it.bookmarked_at || it.created_in_db_at || it.saved_at || 0) || 0;
}

function visibleItems() {
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const it of state.items.values()) {
    const status = it.status || 'unread';
    if (state.status !== 'all' && status !== state.status) continue;
    if (state.type !== 'all' && it.type !== state.type) continue;
    if (state.author && it.author_handle !== state.author) continue;
    if (state.favorite && !it.favorite) continue;
    if (state.incomplete && it.thread_complete !== false) continue;
    if (terms.length) {
      const text = it.search_text || '';
      const local = terms.every((t) => text.includes(t));
      if (!local && !(state.serverHits && state.serverHits.has(it.id))) continue;
    }
    out.push(it);
  }
  const key = state.sort === 'posted' ? (it) => Date.parse(it.created_at || 0) || 0 : bookmarkTime;
  return out.sort((a, b) => key(b) - key(a));
}

// ── Rendering ──────────────────────────────────────────────────────────────

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function render() {
  if (!state.user) return;
  const id = decodeURIComponent((location.hash.match(/^#item\/(.+)$/) || [])[1] || '');
  $('#list-view').hidden = !!id;
  $('#item-view').hidden = !id;
  if (id) return renderItem(state.items.get(id));
  renderAuthors();
  const items = visibleItems();
  $('#count').textContent = `${items.length} of ${state.items.size}`;
  const list = $('#list');
  list.replaceChildren(...items.slice(0, 500).map(row));
  if (items.length === 0) list.append(el('li', { class: 'empty' }, state.items.size ? 'Nothing matches.' : 'No items yet. Save some bookmarks with the extension.'));
  if (items.length > 500) list.append(el('li', { class: 'empty' }, `Showing 500 of ${items.length}. Narrow the search to see more.`));
}

function renderAuthors() {
  const counts = new Map();
  for (const it of state.items.values()) counts.set(it.author_handle, (counts.get(it.author_handle) || 0) + 1);
  const sel = $('#author');
  const opts = [...counts].sort((a, b) => b[1] - a[1]);
  const sig = opts.map((o) => o.join(':')).join(',');
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  sel.replaceChildren(el('option', { value: '' }, 'all authors'), ...opts.map(([h, n]) => el('option', { value: h }, `@${h} (${n})`)));
  sel.value = state.author;
}

function badges(it) {
  return [
    it.type === 'thread' ? el('span', { class: 'badge' }, `thread · ${it.post_count}`) : null,
    it.thread_complete === false ? el('span', { class: 'badge warn', title: 'Open on X, expand the thread, and save it with the extension' }, 'incomplete') : null,
    ...(it.tags || []).map((t) => el('span', { class: 'badge tag' }, `#${t}`)),
  ];
}

function row(it) {
  const status = it.status || 'unread';
  const open = () => (location.hash = `item/${encodeURIComponent(it.id)}`);
  return el(
    'li',
    { class: `row ${status !== 'unread' ? 'read' : ''}` },
    el(
      'div',
      { class: 'main', onclick: open, role: 'link', tabindex: '0', onkeydown: (e) => e.key === 'Enter' && open() },
      el('div', { class: 'meta' }, el('span', { class: 'author' }, it.author_name || it.author_handle), ` @${it.author_handle} · ${fmtDate(it.created_at)}`, ...badges(it)),
      el('div', { class: 'preview' }, it.preview || ''),
    ),
    el(
      'div',
      { class: 'acts' },
      el('button', { class: `star ${it.favorite ? 'on' : ''}`, title: 'Favorite', onclick: () => patch(it.id, { favorite: !it.favorite }) }, it.favorite ? '★' : '☆'),
      el('button', { title: status === 'read' ? 'Mark unread' : 'Mark read', onclick: () => patch(it.id, { status: status === 'read' ? 'unread' : 'read' }) }, status === 'read' ? 'unread' : 'read'),
      el('button', { title: status === 'archived' ? 'Unarchive' : 'Archive', onclick: () => patch(it.id, { status: status === 'archived' ? 'unread' : 'archived' }) }, status === 'archived' ? 'unarchive' : 'archive'),
    ),
  );
}

function renderItem(it) {
  const view = $('#item-view');
  if (!it) return view.replaceChildren(el('a', { href: '#', class: 'back' }, '← back'), el('p', { class: 'empty' }, 'Loading…'));
  const status = it.status || 'unread';
  const posts = it.posts || [];
  const tagInput = el('input', { class: 'tags', value: (it.tags || []).join(', '), placeholder: 'tags, comma separated' });
  tagInput.addEventListener('change', () =>
    patch(it.id, { tags: [...new Set(tagInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))] }),
  );
  const statusBtn = (s) => el('button', { class: status === s ? 'active' : '', onclick: () => patch(it.id, { status: s }) }, s);

  const parts = [
    el('a', { href: '#', class: 'back' }, '← back'),
    el('h2', {}, `${it.author_name} `, el('span', { class: 'muted' }, `@${it.author_handle}`)),
    el(
      'div',
      { class: 'meta' },
      `${fmtDate(it.created_at)} · `,
      el('a', { href: it.url, target: '_blank', rel: 'noopener' }, 'open on X'),
      it.bookmarked_at ? ` · bookmarked ${fmtDate(it.bookmarked_at)}` : '',
      ...badges(it),
    ),
    it.thread_complete === false
      ? el('p', { class: 'warn-note' }, 'Only part of this thread is saved. Open it on X, expand the thread, and press Save (Alt+Shift+S).')
      : null,
    el(
      'div',
      { class: 'item-acts' },
      el('div', { class: 'folder-toggle' }, statusBtn('unread'), statusBtn('read'), statusBtn('archived')),
      el('button', { class: `star ${it.favorite ? 'on' : ''}`, onclick: () => patch(it.id, { favorite: !it.favorite }) }, it.favorite ? '★ favorite' : '☆ favorite'),
      tagInput,
      el('button', { onclick: () => download(itemFilename(it), itemToMarkdown(it), 'text/markdown') }, 'export .md'),
    ),
    el(
      'ol',
      { class: 'posts' },
      posts.map((p, i) =>
        el(
          'li',
          { class: `post ${p.id === it.bookmarked_post_id && posts.length > 1 ? 'bookmarked' : ''}` },
          posts.length > 1 ? el('div', { class: 'num' }, `${i + 1}/${posts.length}`, p.id === it.bookmarked_post_id ? ' · bookmarked' : '') : null,
          el('div', { class: `text ${p.unavailable ? 'muted' : ''}` }, linkify(p.unavailable ? '[unavailable]' : p.text)),
          p.quoted
            ? el(
                'blockquote',
                {},
                el('div', { class: 'meta' }, p.quoted.author_handle ? `@${p.quoted.author_handle}` : 'quoted post', ' · ', p.quoted.url ? el('a', { href: p.quoted.url, target: '_blank', rel: 'noopener' }, 'open') : ''),
                el('div', { class: 'text' }, linkify(p.quoted.text)),
              )
            : null,
          (p.media || []).length
            ? el('ul', { class: 'media' }, p.media.map((m, j) => el('li', {}, el('a', { href: m, target: '_blank', rel: 'noopener' }, `${/\.mp4/.test(m) ? 'video' : 'image'} ${j + 1}`))))
            : null,
          el('a', { class: 'post-link', href: `https://x.com/${it.author_handle}/status/${p.id}`, target: '_blank', rel: 'noopener' }, fmtDate(p.created_at) || 'link'),
        ),
      ),
    ),
  ];
  view.replaceChildren(...parts.filter(Boolean));
}

/** Text with http(s) links made clickable, built from text nodes only. */
function linkify(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of String(text).matchAll(/https?:\/\/[^\s<>"]+/g)) {
    frag.append(text.slice(last, m.index));
    const href = m[0].replace(/[.,;:!?)\]]+$/, '');
    frag.append(el('a', { href, target: '_blank', rel: 'noopener' }, href));
    last = m.index + href.length;
  }
  frag.append(text.slice(last));
  return frag;
}

function download(name, content, type) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportAll() {
  const zip = new JSZip();
  for (const it of state.items.values()) zip.file(itemFilename(it), itemToMarkdown(it));
  const blob = await zip.generateAsync({ type: 'blob' });
  download(`x-bookmarks-${new Date().toISOString().slice(0, 10)}.zip`, blob);
}

function showError(e) {
  const box = $('#error');
  box.hidden = !e;
  box.textContent = e ? `Error: ${e.message || e}` : '';
}

// ── Wiring ─────────────────────────────────────────────────────────────────

let debounce;
$('#search').addEventListener('input', (e) => {
  state.q = e.target.value;
  state.serverHits = null;
  clearTimeout(debounce);
  const word = state.q.trim().toLowerCase();
  if (word && !/\s/.test(word)) debounce = setTimeout(() => serverSearch(word), 300);
  render();
});
$('#sort').addEventListener('change', (e) => ((state.sort = e.target.value), render()));
$('#type').addEventListener('change', (e) => ((state.type = e.target.value), render()));
$('#author').addEventListener('change', (e) => ((state.author = e.target.value), render()));
$('#fav').addEventListener('change', (e) => ((state.favorite = e.target.checked), render()));
$('#incomplete').addEventListener('change', (e) => ((state.incomplete = e.target.checked), render()));
for (const b of document.querySelectorAll('#status button')) {
  b.addEventListener('click', () => {
    state.status = b.dataset.status;
    for (const o of document.querySelectorAll('#status button')) o.classList.toggle('active', o === b);
    render();
  });
}
$('#export-all').addEventListener('click', () => exportAll().catch(showError));
$('#signin').addEventListener('click', () => signInWithPopup(auth, new GoogleAuthProvider()).catch(showError));
$('#signout').addEventListener('click', () => signOut(auth));
window.addEventListener('hashchange', render);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    $('#search').focus();
  }
});

onAuthStateChanged(auth, (user) => {
  state.user = user;
  $('#signed-out').hidden = !!user;
  $('#app').hidden = !user;
  $('#account').textContent = user ? user.email : '';
  $('#signout').hidden = !user;
  state.items.clear();
  if (user) subscribe();
  else state.unsub?.();
});
