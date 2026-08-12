/**
 * VSHermes Home view — a compact icon-button hub that keeps action buttons
 * out of the Chat/History tab headers. Future actions slot into BUTTONS.
 * Icon-only buttons with hover tooltips (title); labels live in the tooltip
 * so the tab stays small.
 */

import type { HostMessage, WebviewMessage } from './protocol';

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

const statusEl = document.getElementById('status') as HTMLDivElement;
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

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  const msg = e.data;
  if (msg.type === 'state') {
    if (msg.connected) {
      statusEl.textContent = `● Connected — ${msg.baseUrl}`;
      statusEl.className = 'status ok';
    } else {
      statusEl.textContent = `○ Offline — ${msg.baseUrl}`;
      statusEl.className = 'status bad';
    }
  }
});

post({ type: 'ready' });
