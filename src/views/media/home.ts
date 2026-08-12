/**
 * VSHermes Home view — a compact icon-button dock. Keeps action buttons out
 * of the Chat/History tab headers while staying as small as possible.
 * Every action here is also a command-palette command; the dock is a
 * shortcut, not the only door. Future actions slot into the BUTTONS array.
 */

import type { WebviewMessage } from './protocol';

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
};

const vscode = acquireVsCodeApi();
const post = (msg: WebviewMessage): void => {
  vscode.postMessage(msg);
};

interface HomeButton {
  id: string;
  glyph: string;
  title: string;
  msg: WebviewMessage;
}

const BUTTONS: HomeButton[] = [
  { id: 'new', glyph: '+', title: 'New Chat — start a new session', msg: { type: 'newSession' } },
  { id: 'sync', glyph: '⟳', title: 'Check Sync — VSHermes ↔ Hermes', msg: { type: 'checkSync' } },
  { id: 'model', glyph: '⚙', title: 'Switch Model — change the model for this session', msg: { type: 'chooseModel' } },
  { id: 'key', glyph: '🔑', title: 'Set API Key — set or clear the key', msg: { type: 'setApiKey' } },
  { id: 'refresh', glyph: '↻', title: 'Refresh History — reload the session list', msg: { type: 'listSessions' } },
];

const gridEl = document.getElementById('grid') as HTMLDivElement;

for (const b of BUTTONS) {
  const el = document.createElement('button');
  el.className = 'action';
  el.textContent = b.glyph;
  el.title = b.title;
  el.setAttribute('aria-label', b.title);
  el.addEventListener('click', () => post(b.msg));
  gridEl.appendChild(el);
}

post({ type: 'ready' });
