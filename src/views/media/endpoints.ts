/**
 * VSHermes Endpoints panel frontend.
 *
 * Lists endpoint profiles (name, URL, active ✓, remote/local badge, key
 * status), lets the user add/edit/remove profiles, set the active one,
 * store per-profile API keys (SecretStorage on the host — never here) and
 * test connectivity. File attach is hard-disabled on remote endpoints (the
 * gateway can't receive files), which the panel states explicitly.
 */

import type { EndpointProfile } from '../../endpointCore';
import type { EndpointsHostMessage, EndpointsWebviewMessage } from './protocol';

declare function acquireVsCodeApi(): {
  postMessage(msg: EndpointsWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// ── DOM refs ───────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id.replace(/^#/, '')) as T;
const listEl = $('#endpoint-list');
const statusEl = $('#status');
const newName = $('#new-name') as HTMLInputElement;
const newUrl = $('#new-url') as HTMLInputElement;
const addBtn = $('#add-btn') as HTMLButtonElement;

// ── state ──────────────────────────────────────────────────────────

interface PanelState {
  endpoints: EndpointProfile[];
  activeId: string | null;
  keySet: string[];
  remote: boolean;
  connected: boolean;
  baseUrl: string;
  localUrl: string;
  testResults: Map<string, { ok: boolean; detail: string }>;
}

const state: PanelState = {
  endpoints: [],
  activeId: null,
  keySet: [],
  remote: false,
  connected: false,
  baseUrl: '',
  localUrl: 'http://127.0.0.1:8642',
  testResults: new Map(),
};

// ── messages ───────────────────────────────────────────────────────

// acquireVsCodeApi may only be called ONCE per webview — repeated calls
// throw, so grab the handle at load and reuse it (same pattern as chat.ts).
const vscode = acquireVsCodeApi();

function post(msg: EndpointsWebviewMessage): void {
  vscode.postMessage(msg);
}

// Boot diagnostics — a dead panel must never be silent: script errors are
// reported to the host, which logs them and shows a note in the panel.
window.addEventListener('error', (e) => {
  try {
    post({ type: 'diag', level: 'error', message: `panel error: ${e.message}` });
  } catch {
    /* host unreachable */
  }
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const reason = (e as PromiseRejectionEvent).reason;
    post({ type: 'diag', level: 'error', message: `panel unhandled rejection: ${String(reason ?? '')}` });
  } catch {
    /* host unreachable */
  }
});

function onHostMessage(msg: EndpointsHostMessage): void {
  if (msg.type === 'state') {
    state.endpoints = msg.endpoints;
    state.activeId = msg.activeId;
    state.keySet = msg.keySet;
    state.remote = msg.remote;
    state.connected = msg.connected;
    state.baseUrl = msg.baseUrl;
    state.localUrl = msg.localUrl;
    render();
  } else if (msg.type === 'testResult') {
    state.testResults.set(msg.id, { ok: msg.ok, detail: msg.detail });
    render();
  } else if (msg.type === 'note') {
    statusEl.textContent = msg.text;
    statusEl.classList.add('note');
  }
}

// ── render ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function render(): void {
  listEl.innerHTML = '';
  // The built-in Local connection always exists — activate it to return to
  // the legacy resolution (baseUrl setting → Hermes .env → default).
  listEl.appendChild(renderLocalRow());
  if (state.endpoints.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      'No custom endpoints yet. Add one below — e.g. a remote machine running the Hermes API server (http://host:8642).';
    listEl.appendChild(empty);
  }
  for (const ep of state.endpoints) {
    listEl.appendChild(renderRow(ep));
  }
  statusEl.textContent = state.connected
    ? `● connected to ${state.baseUrl}${state.remote ? ' (remote)' : ''}`
    : `○ ${state.baseUrl}${state.remote ? ' (remote)' : ''}`;
  statusEl.classList.remove('note');
}

/** The built-in "Local connection" row — the legacy no-profile endpoint. */
function renderLocalRow(): HTMLElement {
  const ep: EndpointProfile = { id: 'local', name: 'Local connection', url: state.localUrl };
  const row = renderRow(ep, true);
  const keyBadge = row.querySelector('.key-badge');
  if (keyBadge) {
    keyBadge.textContent = 'legacy key';
    keyBadge.className = 'badge ok';
  }
  return row;
}

function renderRow(ep: EndpointProfile, isLocal = false): HTMLElement {
  const active = isLocal ? state.activeId === null : ep.id === state.activeId;
  const row = document.createElement('div');
  row.className = 'endpoint' + (active ? ' active' : '');

  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('span');
  title.className = 'name';
  title.textContent = `${ep.name}${active ? ' — active' : ''}`;
  const badges = document.createElement('span');
  badges.className = 'badges';
  const remoteBadge = document.createElement('span');
  remoteBadge.className = 'badge ' + (isRemote(ep.url) ? 'remote' : 'local');
  remoteBadge.textContent = isRemote(ep.url) ? 'remote — attach disabled' : 'local — attach enabled';
  badges.appendChild(remoteBadge);
  const keyBadge = document.createElement('span');
  keyBadge.className = 'badge key-badge ' + (state.keySet.includes(ep.id) ? 'ok' : 'warn');
  keyBadge.textContent = state.keySet.includes(ep.id) ? 'key ✓' : 'no key';
  badges.appendChild(keyBadge);
  head.appendChild(title);
  head.appendChild(badges);
  row.appendChild(head);

  // Editable fields (custom profiles only — Local is the legacy chain).
  let nameInput: HTMLInputElement | undefined;
  let urlInput: HTMLInputElement | undefined;
  if (!isLocal) {
    const fields = document.createElement('div');
    fields.className = 'fields';
    nameInput = document.createElement('input');
    nameInput.className = 'name-in';
    nameInput.value = ep.name;
    urlInput = document.createElement('input');
    urlInput.className = 'url-in';
    urlInput.value = ep.url;
    fields.appendChild(nameInput);
    fields.appendChild(urlInput);
    row.appendChild(fields);

    // Key entry (stored host-side in SecretStorage).
    const keyRow = document.createElement('div');
    keyRow.className = 'keyrow';
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = 'API key (SecretStorage)';
    const keyBtn = document.createElement('button');
    keyBtn.textContent = 'Save key';
    keyBtn.onclick = () => {
      if (keyInput.value.trim()) post({ type: 'setKey', id: ep.id, key: keyInput.value.trim() });
      keyInput.value = '';
    };
    keyRow.appendChild(keyInput);
    keyRow.appendChild(keyBtn);
    row.appendChild(keyRow);
  }

  // Actions.
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (!active) {
    const activate = document.createElement('button');
    activate.textContent = 'Activate';
    activate.onclick = () => post({ type: 'setActive', id: isLocal ? null : ep.id });
    actions.appendChild(activate);
  }
  if (!isLocal) {
    const save = document.createElement('button');
    save.textContent = 'Save';
    save.onclick = () => {
      if (nameInput?.value.trim() && urlInput?.value.trim()) {
        post({ type: 'update', id: ep.id, name: nameInput.value.trim(), url: urlInput.value.trim() });
      }
    };
    actions.appendChild(save);
  }
  const test = document.createElement('button');
  test.textContent = 'Test';
  test.onclick = () => post({ type: 'test', id: ep.id });
  actions.appendChild(test);
  if (!isLocal) {
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.onclick = () => post({ type: 'remove', id: ep.id });
    actions.appendChild(remove);
  }
  row.appendChild(actions);

  // Test result line.
  const result = state.testResults.get(ep.id);
  if (result) {
    const line = document.createElement('div');
    line.className = 'test-result ' + (result.ok ? 'ok' : 'err');
    line.textContent = result.detail;
    row.appendChild(line);
  }

  return row;
}

function isRemote(url: string): boolean {
  try {
    return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ── wiring ─────────────────────────────────────────────────────────

window.addEventListener('message', (e: MessageEvent<EndpointsHostMessage>) => {
  onHostMessage(e.data);
});

addBtn.addEventListener('click', () => {
  const name = newName.value.trim();
  const url = newUrl.value.trim();
  if (!url) {
    statusEl.textContent = 'URL is required — e.g. http://192.168.1.20:8642';
    statusEl.classList.add('note');
    newUrl.focus();
    return;
  }
  // Name is optional: default to the URL's host.
  let label = name;
  if (!label) {
    try {
      label = new URL(url.includes('://') ? url : `http://${url}`).hostname;
    } catch {
      label = url;
    }
  }
  post({ type: 'add', name: label, url });
  newName.value = '';
  newUrl.value = '';
});

post({ type: 'ready' });
