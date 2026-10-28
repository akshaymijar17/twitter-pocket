import { CONFIG } from '../config';
import type { Settings } from '../shared/messages';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function load(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { debug: false, viewerUrl: CONFIG.viewerUrl, ...(settings as Partial<Settings>) };
}

async function save(patch: Partial<Settings>) {
  const next = { ...(await load()), ...patch };
  await chrome.storage.local.set({ settings: next });
  $('saved').textContent = 'Saved.';
  setTimeout(() => ($('saved').textContent = ''), 1500);
}

function row(cells: (string | Node)[], cls?: string) {
  const tr = document.createElement('tr');
  for (const c of cells) {
    const td = document.createElement('td');
    td.append(c);
    tr.append(td);
  }
  if (cls) tr.className = cls;
  return tr;
}

async function renderCaptures() {
  const { captures = {}, lastCaptureAt } = await chrome.storage.session.get(['captures', 'lastCaptureAt']);
  const entries = Object.entries(captures as Record<string, number>);
  if (entries.length === 0) return;
  $('captures').replaceChildren(
    ...entries.map(([op, n]) => row([op, `${n} response${n === 1 ? '' : 's'}`])),
    row(['last capture', String(lastCaptureAt ?? '')]),
  );
}

async function init() {
  const s = await load();
  $<HTMLInputElement>('viewer').value = s.viewerUrl;
  $<HTMLInputElement>('debug').checked = s.debug;
  $<HTMLInputElement>('viewer').onchange = (e) => save({ viewerUrl: (e.target as HTMLInputElement).value.trim() });
  $<HTMLInputElement>('debug').onchange = (e) => save({ debug: (e.target as HTMLInputElement).checked });
  $('ext-id').textContent = chrome.runtime.id;
  $('redirect').textContent = chrome.identity.getRedirectURL();

  $('spike').onclick = async () => {
    $('results').replaceChildren(row(['Running…']));
    const r = await chrome.runtime.sendMessage({ type: 'spike' });
    $('results').replaceChildren(
      ...(r.lines ?? [{ check: 'Error', ok: false, detail: r.error }]).map((l: any) =>
        row([l.ok ? 'PASS' : 'FAIL', l.check, l.detail], l.ok ? 'ok' : 'bad'),
      ),
    );
    await renderCaptures();
  };
  await renderCaptures();
  setInterval(renderCaptures, 2000);
}

void init();
