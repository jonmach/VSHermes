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
  testResults: Map<string, { ok: boolean; detail: string }>;
}

const state: PanelState = {
  endpoints: [],
  activeId: null,
  keySet: [],
  remote: false,
  connected: false,
  baseUrl: '',
  testResults: new Map(),
};

// ── messages ───────────────────────────────────────────────────────

function post(msg: EndpointsWebviewMessage): void {
  try {
    const vscode = acquireVsCodeApi();
    vscode.postMessage(msg);
  } catch {
    /* host unreachable */
  }
}

function onHostMessage(msg: EndpointsHostMessage): void {
  if (msg.type === 'state') {
    state.endpoints = msg.endpoints;
    state.activeId = msg.activeId;
    state.keySet = msg.keySet;
    state.remote = msg.remote;
    state.connected = msg.connected;
    state.baseUrl = msg.baseUrl;
    render();
  } else if (msg.type === 'testResult') {
    state.testResults.set(msg.id, { ok: msg.ok, detail: msg.detail });
    render();
  }
}

// ── render ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function render(): void {
  listEl.innerHTML = '';
  if (state.endpoints.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      'No endpoints yet. Add one below — e.g. a remote machine running the Hermes API server (http://host:8642).';
    listEl.appendChild(empty);
  }
  for (const ep of state.endpoints) {
    listEl.appendChild(renderRow(ep));
  }
  statusEl.textContent = state.connected
    ? `● connected to ${state.baseUrl}${state.remote ? ' (remote)' : ''}`
    : `○ ${state.baseUrl}${state.remote ? ' (remote)' : ''}`;
}

function renderRow(ep: EndpointProfile): HTMLElement {
  const row = document.createElement('div');
  row.className = 'endpoint' + (ep.id === state.activeId ? ' active' : '');

  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('span');
  title.className = 'name';
  title.textContent = `${ep.name}${ep.id === state.activeId ? ' — active' : ''}`;
  const badges = document.createElement('span');
  badges.className = 'badges';
  const remoteBadge = document.createElement('span');
  remoteBadge.className = 'badge ' + (isRemote(ep.url) ? 'remote' : 'local');
  remoteBadge.textContent = isRemote(ep.url) ? 'remote — attach disabled' : 'local — attach enabled';
  badges.appendChild(remoteBadge);
  const keyBadge = document.createElement('span');
  keyBadge.className = 'badge ' + (state.keySet.includes(ep.id) ? 'ok' : 'warn');
  keyBadge.textContent = state.keySet.includes(ep.id) ? 'key ✓' : 'no key';
  badges.appendChild(keyBadge);
  head.appendChild(title);
  head.appendChild(badges);
  row.appendChild(head);

  // Editable fields.
  const fields = document.createElement('div');
  fields.className = 'fields';
  const nameInput = document.createElement('input');
  nameInput.className = 'name-in';
  nameInput.value = ep.name;
  const urlInput = document.createElement('input');
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

  // Actions.
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (ep.id !== state.activeId) {
    const activate = document.createElement('button');
    activate.textContent = 'Activate';
    activate.onclick = () => post({ type: 'setActive', id: ep.id });
    actions.appendChild(activate);
  }
  const save = document.createElement('button');
  save.textContent = 'Save';
  save.onclick = () => {
    if (nameInput.value.trim() && urlInput.value.trim()) {
      post({ type: 'update', id: ep.id, name: nameInput.value.trim(), url: urlInput.value.trim() });
    }
  };
  actions.appendChild(save);
  const test = document.createElement('button');
  test.textContent = 'Test';
  test.onclick = () => post({ type: 'test', id: ep.id });
  actions.appendChild(test);
  const remove = document.createElement('button');
  remove.className = 'danger';
  remove.textContent = 'Remove';
  remove.onclick = () => post({ type: 'remove', id: ep.id });
  actions.appendChild(remove);
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
  if (newName.value.trim() && newUrl.value.trim()) {
    post({ type: 'add', name: newName.value.trim(), url: newUrl.value.trim() });
    newName.value = '';
    newUrl.value = '';
  }
});

post({ type: 'ready' });
