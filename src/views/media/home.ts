/**
 * VSHermes Home view — a button hub that keeps action buttons out of the
 * Chat/History tab headers. Future actions slot into the BUTTONS array.
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
  label: string;
  title: string;
  msg: WebviewMessage;
}

const BUTTONS: HomeButton[] = [
  { id: 'new', label: '+ New Chat', title: 'Start a new chat session', msg: { type: 'newSession' } },
  { id: 'sync', label: '⟳ Check Sync', title: 'Check VSHermes ↔ Hermes sync', msg: { type: 'checkSync' } },
  { id: 'model', label: '⚙ Switch Model', title: 'Change the model for this session', msg: { type: 'chooseModel' } },
  { id: 'history', label: '☰ History', title: 'Open session history', msg: { type: 'focusHistory' } },
  { id: 'key', label: '🔑 Set API Key', title: 'Set or clear the API key', msg: { type: 'setApiKey' } },
  { id: 'refresh', label: '⟳ Refresh History', title: 'Reload the session list', msg: { type: 'listSessions' } },
];

const statusEl = document.getElementById('status') as HTMLDivElement;
const gridEl = document.getElementById('grid') as HTMLDivElement;

for (const b of BUTTONS) {
  const el = document.createElement('button');
  el.className = 'action';
  el.textContent = b.label;
  el.title = b.title;
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
