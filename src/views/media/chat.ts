/**
 * VSHermes webview frontend.
 *
 * Thin client: renders chat, streams events forwarded by the extension
 * host, and implements the input UX (Shift+Enter newline, image paste/drop,
 * slash command picker, approval dialogs, sync banner).
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { filterSlash, matchSlash, type SlashCommandDef } from '../../slash/commands';
import type { SyncReport } from '../../api/sync';
import type {
  ApprovalDecision,
  ChatMessage,
  MessagePart,
  StreamEvent,
} from '../../api/types';
import type { HostMessage, WebviewMessage } from './protocol';

marked.setOptions({ breaks: true, gfm: true });

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
};

const vscode = acquireVsCodeApi();
const post = (msg: WebviewMessage): void => {
  vscode.postMessage(msg);
};

// Boot diagnostics — report any script-level failure to the host so a dead
// webview is never silent (the host logs it and shows an error toast).
window.addEventListener('error', (e) => {
  try {
    post({ type: 'diag', level: 'error', message: `webview error: ${e.message}` });
  } catch {
    /* host unreachable */
  }
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const reason = (e as PromiseRejectionEvent).reason;
    post({ type: 'diag', level: 'error', message: `webview unhandled rejection: ${String(reason ?? '')}` });
  } catch {
    /* host unreachable */
  }
});

// ── DOM refs ───────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id.replace(/^#/, '')) as T;
const messagesEl = $('#messages');
const inputEl = $('#input') as HTMLTextAreaElement;
const sendBtn = $('#send-btn') as HTMLButtonElement;
const chipsEl = $('#chips');
const slashPopup = $('#slash-popup');
const approvalEl = $('#approval');
const approvalCmd = $('#approval-cmd');
const syncBanner = $('#sync-banner');
const connEl = $('#conn');
const modelBadge = $('#model-badge');

// ── state ──────────────────────────────────────────────────────────

interface ToolCard {
  el: HTMLElement;
  done: boolean;
}

interface RenderMsg {
  el: HTMLElement;
  kind: 'user' | 'assistant' | 'note' | 'error';
  /** Assistant streaming content element. */
  contentEl?: HTMLElement;
  content?: string;
  thinkingEl?: HTMLElement;
  thinking?: string;
  tools: Map<string, ToolCard>;
}

const state: {
  connected: boolean;
  sessionId: string | null;
  model: string | null;
  slashCommands: SlashCommandDef[];
  syncReport: SyncReport | null;
  streaming: boolean;
  messages: RenderMsg[];
  active: RenderMsg | null;
  chips: string[];
  approval: unknown | null;
  slashIndex: number;
  slashQuery: string;
  maxImageBytes: number;
  maxImageDimension: number;
} = {
  connected: false,
  sessionId: null,
  model: null,
  slashCommands: [],
  syncReport: null,
  streaming: false,
  messages: [],
  active: null,
  chips: [],
  approval: null,
  slashIndex: 0,
  slashQuery: '',
  maxImageBytes: 8 * 1024 * 1024,
  maxImageDimension: 4096,
};

// ── markdown ───────────────────────────────────────────────────────

function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}

function setContent(el: HTMLElement, text: string): void {
  el.innerHTML = renderMarkdown(text);
  // Keep scroll pinned to bottom while streaming.
  const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── message construction ───────────────────────────────────────────

function addUserMessage(text: string, images: string[]): RenderMsg {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  if (images.length > 0) {
    const imgs = document.createElement('div');
    imgs.className = 'images';
    for (const url of images) {
      const img = document.createElement('img');
      img.src = url;
      imgs.appendChild(img);
    }
    wrap.appendChild(imgs);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (text.trim()) bubble.textContent = text;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  const msg: RenderMsg = { el: wrap, kind: 'user', tools: new Map() };
  state.messages.push(msg);
  scrollBottom();
  return msg;
}

function addAssistantMessage(): RenderMsg {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = '<span class="meta">…</span>';
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  const msg: RenderMsg = {
    el: wrap,
    kind: 'assistant',
    contentEl: bubble,
    content: '',
    tools: new Map(),
  };
  state.messages.push(msg);
  scrollBottom();
  return msg;
}

function addToolCard(msg: RenderMsg, toolName: string, preview: string | null, args: Record<string, unknown> | null): ToolCard {
  const key = toolName + ':' + (state.messages.indexOf(msg));
  let card = msg.tools.get(key);
  if (card) return card;
  const el = document.createElement('div');
  el.className = 'tool-card';
  const previewText =
    preview ??
    (args && Object.keys(args).length > 0
      ? Object.entries(args)
          .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' · ')
          .slice(0, 300)
      : null);
  el.innerHTML = `<span class="tname">${escapeHtml(toolName)}</span> <span class="tstatus">… running</span>${
    previewText ? `<pre>${escapeHtml(previewText)}</pre>` : ''
  }`;
  // Insert tool card above the assistant bubble if present.
  if (msg.contentEl) {
    msg.el.insertBefore(el, msg.contentEl);
  } else {
    msg.el.appendChild(el);
  }
  card = { el, done: false };
  msg.tools.set(key, card);
  scrollBottom();
  return card;
}

function ensureThinking(msg: RenderMsg): HTMLElement {
  if (msg.thinkingEl) return msg.thinkingEl;
  const el = document.createElement('details');
  el.className = 'thinking';
  el.innerHTML = '<summary>thinking…</summary><div class="body"></div>';
  msg.el.insertBefore(el, msg.contentEl ?? null);
  msg.thinkingEl = el;
  return el;
}

function addNote(text: string, error = false): void {
  const el = document.createElement('div');
  el.className = error ? 'error-note' : 'info-note';
  el.textContent = text;
  messagesEl.appendChild(el);
  state.messages.push({ el, kind: error ? 'error' : 'note', tools: new Map() });
  scrollBottom();
}

function scrollBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

// ── rendering from stored messages ─────────────────────────────────

function renderMessages(messages: ChatMessage[]): void {
  messagesEl.innerHTML = '';
  state.messages = [];
  state.active = null;
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  messagesEl.appendChild(spacer);

  for (const m of messages) {
    if (m.role === 'user') {
      const msg = addUserMessage(m.content ?? '', extractImages(m.content));
      msg.el.querySelector('.bubble')!.textContent = m.content ?? '';
    } else if (m.role === 'assistant') {
      const msg = addAssistantMessage();
      msg.content = m.content ?? '';
      if (msg.content) setContent(msg.contentEl!, msg.content);
      else msg.contentEl!.textContent = '…';
      if (m.reasoning || m.reasoning_content) {
        const t = ensureThinking(msg);
        t.querySelector('.body')!.textContent = m.reasoning_content ?? m.reasoning ?? '';
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls as Array<{ name?: string; function?: { name?: string; arguments?: string } }>) {
          const name = tc.name ?? tc.function?.name ?? 'tool';
          let argsPreview: string | null = null;
          try {
            const args = JSON.parse(tc.function?.arguments ?? '{}');
            argsPreview = Object.entries(args)
              .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
              .join(' · ')
              .slice(0, 300);
          } catch {
            argsPreview = tc.function?.arguments?.slice(0, 300) ?? null;
          }
          const card = addToolCard(msg, name, argsPreview, null);
          card.el.querySelector('.tstatus')!.textContent = 'done';
          card.done = true;
        }
      }
    }
  }
  scrollBottom();
}

function extractImages(content: string | null): string[] {
  if (!content) return [];
  const out: string[] = [];
  const re = /data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/g;
  for (const m of content.matchAll(re)) {
    if (m[0].length > 100) out.push(m[0]);
  }
  return out.slice(0, 4);
}

// ── sync banner ────────────────────────────────────────────────────

function renderSyncBanner(report: SyncReport | null): void {
  syncBanner.classList.remove('show', 'ok', 'warn');
  syncBanner.innerHTML = '';
  if (!report) return;

  const msg = document.createElement('div');
  msg.className = 'msg';
  const btn = document.createElement('button');
  btn.textContent = 'Re-check';
  btn.onclick = () => post({ type: 'checkSync' });

  if (report.status === 'ok') {
    const checked = new Date(report.checkedAt).toLocaleTimeString();
    msg.textContent = `✓ In sync with Hermes ${report.hermesVersion ?? ''} — checked ${checked}`;
    syncBanner.classList.add('show', 'ok');
  } else if (report.status === 'unknown') {
    msg.textContent = '? Could not reach Hermes for a sync check.';
    syncBanner.classList.add('show', 'warn');
  } else if (report.status === 'outdated') {
    msg.textContent = '⚠ VSHermes is out of sync with Hermes: ' + report.messages.join(' ');
    syncBanner.classList.add('show', 'warn');
  } else {
    msg.textContent = 'ℹ Hermes is newer than this plugin: ' + report.messages.join(' ');
    syncBanner.classList.add('show');
  }
  syncBanner.appendChild(msg);
  syncBanner.appendChild(btn);
}

// ── streaming events ───────────────────────────────────────────────

function onStreamEvent(ev: StreamEvent): void {
  switch (ev.type) {
    case 'run.started':
      state.streaming = true;
      updateRunUi();
      break;
    case 'message.started':
      state.active = addAssistantMessage();
      break;
    case 'assistant.delta': {
      if (!state.active) state.active = addAssistantMessage();
      state.active.content = (state.active.content ?? '') + ev.delta;
      setContent(state.active.contentEl!, state.active.content);
      break;
    }
    case 'tool.started': {
      if (!state.active) state.active = addAssistantMessage();
      const card = addToolCard(state.active, ev.tool_name, ev.preview, ev.args ?? null);
      card.el.querySelector('.tstatus')!.textContent = 'running…';
      break;
    }
    case 'tool.progress': {
      if (!state.active) break;
      if (ev.tool_name === '_thinking') {
        const t = ensureThinking(state.active);
        const body = t.querySelector('.body')!;
        body.textContent = (body.textContent ?? '') + ev.delta;
        scrollBottom();
      } else {
        const card = addToolCard(state.active, ev.tool_name, null, null);
        const pre = card.el.querySelector('pre');
        if (pre) {
          pre.textContent = (pre.textContent ?? '') + ev.delta;
          pre.scrollTop = pre.scrollHeight;
        }
      }
      break;
    }
    case 'tool.completed': {
      if (!state.active) break;
      const card = addToolCard(state.active, ev.tool_name, null, null);
      card.el.querySelector('.tstatus')!.textContent = 'done';
      card.done = true;
      break;
    }
    case 'assistant.completed': {
      if (state.active) {
        state.active.content = ev.content;
        setContent(state.active.contentEl!, ev.content);
        if (ev.interrupted) {
          addNote('(interrupted)', false);
        }
      }
      break;
    }
    case 'run.completed':
      break;
    case 'done':
      state.streaming = false;
      updateRunUi();
      break;
    default:
      if (ev.type.startsWith('approval.')) {
        state.approval = ev;
        showApproval(ev);
      }
  }
}

function updateRunUi(): void {
  sendBtn.disabled = state.streaming;
  sendBtn.textContent = state.streaming ? '■' : '➤';
  sendBtn.title = state.streaming ? 'Stop' : 'Send';
}

// ── approval dialog ────────────────────────────────────────────────

function showApproval(ev: unknown): void {
  const raw = ev as Record<string, unknown>;
  const cmd =
    (typeof raw.command === 'string' && raw.command) ||
    (typeof raw.preview === 'string' && raw.preview) ||
    (typeof raw.tool_name === 'string' && `${raw.tool_name} ${JSON.stringify(raw.args ?? '')}`) ||
    JSON.stringify(raw, null, 2).slice(0, 1000);
  approvalCmd.textContent = cmd;
  approvalEl.classList.add('show');
}

function hideApproval(): void {
  approvalEl.classList.remove('show');
  state.approval = null;
}

approvalEl.querySelectorAll('button[data-d]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const decision = (btn as HTMLButtonElement).dataset.d as ApprovalDecision;
    post({ type: 'approve', decision });
    hideApproval();
  });
});

// ── images ─────────────────────────────────────────────────────────

async function addImageFile(file: File): Promise<void> {
  try {
    const url = await fileToDataUrl(file, state.maxImageBytes, state.maxImageDimension);
    state.chips.push(url);
    renderChips();
  } catch {
    addNote('Could not read pasted image.', true);
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Downscale pasted images that exceed the configured byte or dimension
 * limits (screenshots are routinely >8MB; vision APIs reject oversized
 * payloads). Within limits the original bytes pass through untouched.
 */
async function fileToDataUrl(file: File, maxBytes: number, maxDim: number): Promise<string> {
  try {
    const bmp = await createImageBitmap(file);
    const longest = Math.max(bmp.width, bmp.height);
    if (file.size <= maxBytes && longest <= maxDim) {
      bmp.close();
      return await readAsDataUrl(file);
    }
    const scale = Math.min(1, maxDim / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close();
      return await readAsDataUrl(file);
    }
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return canvas.toDataURL(mime, 0.85);
  } catch {
    return await readAsDataUrl(file);
  }
}

function renderChips(): void {
  chipsEl.innerHTML = '';
  state.chips.forEach((url, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const img = document.createElement('img');
    img.src = url;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.onclick = () => {
      state.chips.splice(i, 1);
      renderChips();
    };
    chip.appendChild(img);
    chip.appendChild(x);
    chipsEl.appendChild(chip);
  });
}

// ── slash picker ───────────────────────────────────────────────────

function slashVisible(): boolean {
  return slashPopup.classList.contains('show');
}

function updateSlashPopup(): void {
  const text = inputEl.value;
  const lineStart = text.lastIndexOf('\n') + 1;
  const line = text.slice(lineStart);
  const m = /^\/([a-zA-Z0-9_-]*)$/.exec(line);
  if (!m) {
    hideSlashPopup();
    return;
  }
  state.slashQuery = m[1];
  const items = filterSlash(state.slashQuery);
  state.slashIndex = Math.min(state.slashIndex, Math.max(items.length - 1, 0));
  slashPopup.innerHTML = '';
  items.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'slash-item' + (i === state.slashIndex ? ' selected' : '');
    el.innerHTML = `<span class="sname">/${escapeHtml(c.name)}</span><span class="ssum">${escapeHtml(c.summary)}</span><span class="skind">${c.kind}</span>`;
    el.onclick = () => selectSlash(c);
    slashPopup.appendChild(el);
  });
  slashPopup.classList.add('show');
}

function hideSlashPopup(): void {
  slashPopup.classList.remove('show');
}

function selectSlash(c: SlashCommandDef): void {
  hideSlashPopup();
  const lineStart = inputEl.value.lastIndexOf('\n') + 1;
  inputEl.value = inputEl.value.slice(0, lineStart);
  switch (c.kind) {
    case 'action':
      runSlashAction(c);
      break;
    case 'informational':
      // Sent to Hermes as plain text (documented in the catalog).
      void sendNow(`/${c.name}`);
      break;
    case 'unsupported':
      addNote(`/${c.name} is a TUI-only command — not available through the Hermes API server. ${c.summary}`, true);
      break;
  }
  inputEl.focus();
}

function runSlashAction(c: SlashCommandDef): void {
  switch (c.handler) {
    case 'new-session':
    case 'clear-session':
      post({ type: 'newSession' });
      break;
    case 'choose-model':
      post({ type: 'chooseModel' });
      break;
    case 'stop':
      post({ type: 'stop' });
      break;
    case 'history':
      post({ type: 'focusHistory' });
      break;
    case 'skills':
      post({ type: 'skills' });
      break;
    case 'fork':
      post({ type: 'forkSession' });
      break;
    case 'help':
      addNote(
        'VSHermes commands:\n' +
          state.slashCommands.map((x) => `/${x.name} — ${x.summary}`).join('\n'),
      );
      break;
  }
}

// ── send ───────────────────────────────────────────────────────────

async function sendNow(textOverride?: string): Promise<void> {
  const text = textOverride ?? inputEl.value;
  if (!text.trim() && state.chips.length === 0) return;
  if (state.streaming) return;

  const parts: MessagePart[] = [];
  if (text.trim()) parts.push({ type: 'text', text: text.trim() });
  for (const url of state.chips) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  addUserMessage(text.trim(), state.chips);
  inputEl.value = '';
  state.chips = [];
  renderChips();
  hideSlashPopup();
  post({ type: 'send', parts });
}

// ── no-session hint ────────────────────────────────────────────────

function ensureNoSessionHint(): void {
  if (document.getElementById('no-session-hint')) return;
  const el = document.createElement('div');
  el.id = 'no-session-hint';
  el.className = 'info-note';
  el.textContent =
    'No session yet — type a message below to start one. New chat, sync check and model live in the chat header + command palette (VSHermes: …).';
  messagesEl.appendChild(el);
  scrollBottom();
}

function clearNoSessionHint(): void {
  document.getElementById('no-session-hint')?.remove();
}

// ── host messages ──────────────────────────────────────────────────

function onHostMessage(msg: HostMessage): void {
  switch (msg.type) {
    case 'state':
      state.connected = msg.connected;
      state.sessionId = msg.sessionId;
      state.model = msg.model;
      state.syncReport = msg.syncReport;
      state.maxImageBytes = msg.maxImageBytes;
      state.maxImageDimension = msg.maxImageDimension;
      if (msg.slashCommands.length > 0) state.slashCommands = msg.slashCommands;
      connEl.textContent = msg.connected ? `● Hermes` : `○ offline (${msg.baseUrl})`;
      connEl.style.color = msg.connected ? 'var(--vsh-accent)' : 'var(--vsh-error)';
      modelBadge.textContent = msg.model ? `⚙ ${msg.model}` : '';
      if (msg.connected && !msg.sessionId) {
        ensureNoSessionHint();
      } else {
        clearNoSessionHint();
      }
      renderSyncBanner(msg.syncReport);
      break;
    case 'session':
      modelBadge.textContent = msg.session.model ? `⚙ ${msg.session.model}` : '';
      break;
    case 'messages':
      renderMessages(msg.messages);
      state.sessionId = msg.sessionId;
      clearNoSessionHint();
      break;
    case 'sessions':
      // History tree is the canonical surface; nothing to render here.
      break;
    case 'sync':
      state.syncReport = msg.report;
      renderSyncBanner(msg.report);
      break;
    case 'stream':
      onStreamEvent(msg.event);
      break;
    case 'stream:ended':
      state.streaming = false;
      updateRunUi();
      if (msg.error) addNote(`Stream ended with an error: ${msg.error}`, true);
      break;
    case 'info':
      addNote(msg.text);
      break;
    case 'error':
      addNote(msg.message, true);
      break;
    case 'model':
      state.model = msg.model;
      modelBadge.textContent = msg.model ? `⚙ ${msg.model}` : '';
      break;
  }
}

// ── wiring ─────────────────────────────────────────────────────────

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  onHostMessage(e.data);
});

inputEl.addEventListener('keydown', (e) => {
  if (slashVisible() && e.key !== 'Escape') {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.slashIndex++;
      updateSlashPopup();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.slashIndex = Math.max(0, state.slashIndex - 1);
      updateSlashPopup();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const items = filterSlash(state.slashQuery);
      const c = items[state.slashIndex];
      if (c) selectSlash(c);
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const m = matchSlash(inputEl.value.trim());
    if (m && m.def && m.def.kind === 'action' && !m.args) {
      // "/new" etc. with no args — run the action instead of sending text.
      if (m.def.handler === 'new-session' || m.def.handler === 'clear-session' || m.def.handler === 'stop' || m.def.handler === 'history' || m.def.handler === 'help') {
        runSlashAction(m.def);
        inputEl.value = '';
        return;
      }
    }
    void sendNow();
    return;
  }
  if (e.key === 'Escape') hideSlashPopup();
  if (e.key === ' ') updateSlashPopup();
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  updateSlashPopup();
});

inputEl.addEventListener('paste', (e) => {
  const files: File[] = [];
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    for (const f of files) void addImageFile(f);
  }
});

inputEl.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (files.length > 0) {
    e.preventDefault();
    for (const f of files) void addImageFile(f);
  }
});

inputEl.addEventListener('dragover', (e) => e.preventDefault());

sendBtn.addEventListener('click', () => {
  if (state.streaming) {
    post({ type: 'stop' });
  } else {
    void sendNow();
  }
});

modelBadge.addEventListener('click', () => post({ type: 'chooseModel' }));

// ── init ───────────────────────────────────────────────────────────

updateRunUi();
post({ type: 'ready' });
