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
import type { FileEntry, HostMessage, WebviewMessage } from './protocol';

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
const inputAreaEl = $('#input-area');
const sendBtn = $('#send-btn') as HTMLButtonElement;
const attachBtn = $('#attach-btn') as HTMLButtonElement;
const chipsEl = $('#chips');
const slashPopup = $('#slash-popup');
const approvalEl = $('#approval');
const approvalCmd = $('#approval-cmd');
const syncBanner = $('#sync-banner');
const connEl = $('#conn');

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
  remote: boolean;
  slashCommands: SlashCommandDef[];
  syncReport: SyncReport | null;
  streaming: boolean;
  messages: RenderMsg[];
  active: RenderMsg | null;
  /** Lineage notice text (compression / fork) pinned above the transcript. */
  lineage: string | null;
  /**
   * Per-turn usage keyed by index into `messages`. The host re-posts the
   * full transcript after every run (refreshSessionAfterRun), which wipes
   * and rebuilds the DOM — this map lets renderMessages re-attach the
   * usage lines that were appended live during streaming.
   */
  usageByTurn: Map<number, { input_tokens: number; output_tokens: number; total_tokens: number }>;
  chips: string[];
  approval: unknown | null;
  slashIndex: number;
  slashQuery: string;
  popupMode: 'slash' | 'file' | null;
  fileResults: FileEntry[];
  fileQuery: string;
  fileIndex: number;
  fileDebounce: ReturnType<typeof setTimeout> | undefined;
  filePostedQuery: string | null;
  mentionStart: number;
  /** Picker insert form: `@<path>` (plain reference) or `@file <path>` (attach). */
  mentionKind: 'ref' | 'attach';
  maxImageBytes: number;
  maxImageDimension: number;
} = {
  connected: false,
  sessionId: null,
  remote: false,
  slashCommands: [],
  syncReport: null,
  streaming: false,
  messages: [],
  active: null,
  lineage: null,
  usageByTurn: new Map(),
  chips: [],
  approval: null,
  slashIndex: 0,
  slashQuery: '',
  popupMode: null,
  fileResults: [],
  fileQuery: '',
  fileIndex: 0,
  fileDebounce: undefined,
  filePostedQuery: null,
  mentionStart: 0,
  mentionKind: 'ref',
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
  addCopyButtons(el);
  // Keep scroll pinned to bottom while streaming.
  const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Copies text to the clipboard (async API with execCommand fallback). */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function flashCopied(btn: HTMLButtonElement, label: string): void {
  btn.textContent = '✓';
  btn.title = 'Copied';
  setTimeout(() => {
    btn.textContent = '⧉';
    btn.title = label;
  }, 1200);
}

/** Hover-only copy button (class controls placement: msg-copy / thinking-copy). */
function makeCopyButton(title: string, getText: () => string, className = 'msg-copy'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = className;
  btn.textContent = '⧉';
  btn.title = title;
  btn.addEventListener('click', () => {
    void writeClipboard(getText()).then((ok) => {
      if (ok) flashCopied(btn, title);
    });
  });
  return btn;
}

/** Adds a copy button to every code block (idempotent for streaming deltas). */
function addCopyButtons(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.querySelector('.copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '⧉';
    btn.title = 'Copy code';
    btn.addEventListener('click', () => {
      const code = (pre.querySelector('code')?.textContent ?? pre.textContent ?? '').trimEnd();
      void writeClipboard(code).then((ok) => {
        if (ok) flashCopied(btn, 'Copy code');
      });
    });
    pre.appendChild(btn);
  }
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
  if (text.trim()) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    const row = document.createElement('div');
    row.className = 'bubble-row';
    row.appendChild(bubble);
    row.appendChild(makeCopyButton('Copy message', () => text));
    wrap.appendChild(row);
  }
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
  const msg: RenderMsg = {
    el: wrap,
    kind: 'assistant',
    contentEl: bubble,
    content: '',
    tools: new Map(),
  };
  const row = document.createElement('div');
  row.className = 'bubble-row';
  row.appendChild(bubble);
  // Live content read at click time — safe during streaming deltas.
  row.appendChild(makeCopyButton('Copy message', () => msg.content ?? ''));
  wrap.appendChild(row);
  messagesEl.appendChild(wrap);
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
  const outPre = el.querySelector('pre');
  if (outPre) {
    // Sibling of the pre, not a child — progress updates rewrite pre.textContent.
    el.appendChild(makeCopyButton('Copy output', () => outPre.textContent ?? '', 'tool-copy'));
  }
  // Insert tool card above the message row if present.
  const anchor = msg.contentEl ? (msg.contentEl.parentElement ?? msg.contentEl) : null;
  if (anchor) {
    msg.el.insertBefore(el, anchor);
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
  const body = el.querySelector('.body') as HTMLElement;
  el.appendChild(makeCopyButton('Copy thinking', () => body.textContent ?? '', 'thinking-copy'));
  // Insert above the message row (the bubble sits inside .bubble-row).
  msg.el.insertBefore(el, msg.contentEl?.parentElement ?? null);
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

/** Last rendered assistant message, or null. */
function lastAssistant(): RenderMsg | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].kind === 'assistant') return state.messages[i];
  }
  return null;
}

/** Compact token count: 1234 → "1.2k", 1234567 → "1.2M", 152000 → "152k" (no trailing .0). Mirrors sessionFormat.ts. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${n}`;
}

/**
 * Per-turn usage line under the last assistant message, fed by
 * run.completed.usage. Rendered as a muted one-liner; the full breakdown
 * (incl. cache/reasoning when the session summary has it) lives in the
 * status-bar tooltip via the session totals.
 */
function appendUsageLine(msg: RenderMsg, usage: { input_tokens: number; output_tokens: number; total_tokens: number }): void {
  const line = document.createElement('div');
  line.className = 'usage-line';
  line.title = `${usage.input_tokens} in · ${usage.output_tokens} out · ${usage.total_tokens} total`;
  line.textContent = `↑${fmtTokens(usage.input_tokens)} in · ↓${fmtTokens(usage.output_tokens)} out · ${fmtTokens(usage.total_tokens)} total`;
  msg.el.appendChild(line);
  scrollBottom();
}

/** Session-lineage notice (compression / fork) — pinned above the transcript. */
function addLineageNote(text: string): void {
  state.lineage = text;
  renderLineageNote();
}

function renderLineageNote(): void {
  const existing = messagesEl.querySelector(':scope > .lineage-note');
  existing?.remove();
  const prior = state.messages.findIndex((m) => m.el.classList.contains('lineage-note'));
  if (prior >= 0) state.messages.splice(prior, 1);
  if (!state.lineage) return;
  const el = document.createElement('div');
  el.className = 'lineage-note';
  el.textContent = state.lineage;
  const spacer = messagesEl.querySelector(':scope > .spacer');
  if (spacer) spacer.after(el);
  else messagesEl.prepend(el);
  state.messages.push({ el, kind: 'note', tools: new Map() });
}

function scrollBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

// ── rendering from stored messages ─────────────────────────────────

function renderMessages(messages: ChatMessage[]): void {
  const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  const prevTop = messagesEl.scrollTop;
  const prevHeight = messagesEl.scrollHeight;
  messagesEl.innerHTML = '';
  state.messages = [];
  state.active = null;
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  messagesEl.appendChild(spacer);

  for (const m of messages) {
    if (m.role === 'user') {
      const content = m.content ?? '';
      const images = [...extractImages(content), ...extractMarkdownImages(content)].slice(0, 4);
      const text = stripImageTokens(content);
      const msg = addUserMessage(text, images);
      const bubble = msg.el.querySelector('.bubble');
      if (bubble) bubble.textContent = text;
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
  // Re-attach per-turn usage lines recorded during streaming. The host
  // re-posts the full transcript after every run (refreshSessionAfterRun),
  // which rebuilds this list from stored messages — the lines appended
  // live by appendUsageLine would otherwise be wiped.
  for (const [idx, usage] of state.usageByTurn) {
    const msg = state.messages[idx];
    if (msg && msg.kind === 'assistant' && !msg.el.querySelector('.usage-line')) {
      appendUsageLine(msg, usage);
    }
  }
  if (atBottom) {
    scrollBottom();
  } else if (prevHeight > 0) {
    // Keep the reading position anchored — new content appended below
    // pushes the scroll range down by the height delta.
    messagesEl.scrollTop = prevTop + (messagesEl.scrollHeight - prevHeight);
  }
  renderLineageNote();
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

/**
 * Enriched file-mode image tokens — "![Image](<webview uri>)" — produced
 * host-side by enrichImageRefs from stored "[Image pasted: …]" references.
 * The webview can load those URIs (localResourceRoots + CSP img-src), so
 * they render as thumbnails exactly like inline data URLs.
 */
const MARKDOWN_IMG_RE = /!\[Image\]\(([^)]+)\)/g;

function extractMarkdownImages(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(MARKDOWN_IMG_RE)) out.push(m[1]);
  return out.slice(0, 4);
}

/** Strip image tokens (markdown image refs + base64 data URLs) from the text
 * shown in the bubble — the image itself renders as a thumbnail, never as
 * raw mime text in the message body. */
function stripImageTokens(content: string): string {
  return content
    .replace(MARKDOWN_IMG_RE, '')
    .replace(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Compact server identity for the header badge: hostname:port. */
function serverHost(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase() + (u.port ? `:${u.port}` : '');
  } catch {
    return url;
  }
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

  if (report.status === 'ok' || report.status === 'ahead' || report.status === 'untested') {
    // Versions only when all is well — no scope-ambiguous claim like
    // "all features available" (that could read as a claim about every
    // Hermes feature). Explanatory text appears only in the other states.
    let text = `✓ VSHermes ${report.pluginVersion} · Hermes ${report.hermesVersion ?? '?'}`;
    if (report.status === 'untested') {
      text += ` (below the verified minimum ${report.pluginMinVersion})`;
    }
    msg.textContent = text;
    syncBanner.classList.add('show', 'ok');
  } else if (report.status === 'unknown') {
    msg.textContent = '? ' + (report.messages[0] ?? 'Could not reach Hermes for a check.');
    syncBanner.classList.add('show', 'warn');
  } else {
    msg.textContent = '⚠ ' + (report.messages[0] ?? 'Some VSHermes features are unavailable.');
    syncBanner.classList.add('show', 'warn');
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
      if (ev.usage && (ev.usage.input_tokens > 0 || ev.usage.output_tokens > 0)) {
        const target = state.active ?? lastAssistant();
        if (target) {
          appendUsageLine(target, ev.usage);
          // Remember the usage for this message so the post-run transcript
          // rebuild (host re-posts 'messages' after every run) re-attaches
          // the line instead of erasing it.
          const idx = state.messages.indexOf(target);
          if (idx >= 0) state.usageByTurn.set(idx, ev.usage);
        }
      }
      dismissStaleApproval();
      break;
    case 'done':
      state.streaming = false;
      updateRunUi();
      dismissStaleApproval();
      break;
    case 'approval.request':
      state.approval = ev;
      showApproval(ev);
      break;
    // Only approval.request opens the dialog — a response event
    // (approval.responded) must not re-show it with the response payload.
  }
}

function updateRunUi(): void {
  // The send button doubles as Stop while streaming — it must stay clickable,
  // so it is never disabled here (the click handler routes to stop/send).
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

/** The run ended (or its stream closed) while an approval was still pending.
 * Server-side the deadline may have expired or the run was aborted — either
 * way the pending approval can no longer be answered, so close the dialog
 * instead of leaving it stuck (clicking it would fail against a dead run). */
function dismissStaleApproval(): void {
  if (!state.approval) return;
  hideApproval();
  addNote('The run ended — the pending approval is no longer active.');
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

// ── slash + @file picker ───────────────────────────────────────────

function popupVisible(): boolean {
  return slashPopup.classList.contains('show');
}

function updatePopup(): void {
  const text = inputEl.value;
  const lineStart = text.lastIndexOf('\n') + 1;
  const line = text.slice(lineStart);
  const sm = /^\/([a-zA-Z0-9_-]*)$/.exec(line);
  if (sm) {
    state.popupMode = 'slash';
    renderSlashItems(sm[1]);
    return;
  }
  // The last '@' anywhere on the current line triggers the file picker —
  // the mention must be the final token on the line, so typing prose after
  // it dismisses the popup naturally. `@file ` selects the ATTACH form
  // (copied into attachments on send); a bare `@` selects the reference
  // form (never copied).
  const fm = /@(file\s+)?(\S*)$/.exec(line);
  if (fm) {
    state.popupMode = 'file';
    state.mentionStart = lineStart + fm.index;
    state.mentionKind = fm[1] ? 'attach' : 'ref';
    renderFileItems(fm[2]);
    return;
  }
  hideSlashPopup();
}

function hideSlashPopup(): void {
  slashPopup.classList.remove('show');
  state.popupMode = null;
  clearTimeout(state.fileDebounce);
  state.fileDebounce = undefined;
}

function renderSlashItems(query: string): void {
  state.slashQuery = query;
  const items = filterSlash(query);
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

function renderFileItems(query: string): void {
  state.fileQuery = query;
  // Debounced host query — the webview has no file access.
  if (query !== state.filePostedQuery) {
    state.filePostedQuery = query;
    clearTimeout(state.fileDebounce);
    state.fileDebounce = setTimeout(() => post({ type: 'fileQuery', query }), 250);
  }
  const items = filteredFiles();
  state.fileIndex = Math.min(state.fileIndex, Math.max(items.length - 1, 0));
  slashPopup.innerHTML = '';
  if (items.length === 0) {
    const el = document.createElement('div');
    el.className = 'slash-item';
    el.innerHTML = `<span class="sname">${state.mentionKind === 'attach' ? '@file' : '@'}</span><span class="ssum">no matching files</span><span class="skind">file</span>`;
    slashPopup.appendChild(el);
  }
  items.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'slash-item' + (i === state.fileIndex ? ' selected' : '');
    const label = state.mentionKind === 'attach' ? `@file ${f.rel}` : `@${f.rel}`;
    el.innerHTML = `<span class="sname">${escapeHtml(label)}</span><span class="skind">file</span>`;
    el.onclick = () => selectFile(f.abs);
    slashPopup.appendChild(el);
  });
  const browse = document.createElement('div');
  browse.className = 'slash-item';
  browse.innerHTML = `<span class="sname">Browse…</span><span class="ssum">any file or folder on this machine</span>`;
  browse.onclick = () => {
    hideSlashPopup();
    post({ type: 'browse' });
  };
  slashPopup.appendChild(browse);
  slashPopup.classList.add('show');
}

function filteredFiles(): FileEntry[] {
  const q = state.fileQuery.toLowerCase();
  return state.fileResults.filter((f) => f.rel.toLowerCase().includes(q));
}

function selectFile(absPath: string): void {
  hideSlashPopup();
  const prefix = state.mentionKind === 'attach' ? '@file ' : '@';
  inputEl.value = inputEl.value.slice(0, state.mentionStart) + `${prefix}${absPath}`;
  resizeInput();
  inputEl.focus();
}

/** Insert attach tokens at the end of the input, each on its own line
 *  (paperclip picker, drag & drop, palette command). */
function appendTokens(tokens: string[]): void {
  hideSlashPopup();
  for (const t of tokens) {
    if (inputEl.value && !inputEl.value.endsWith('\n')) inputEl.value += '\n';
    inputEl.value += t;
  }
  resizeInput();
  inputEl.focus();
}

/** Keep the textarea height in step with its content (input events only fire
 *  on typing — programmatic value changes need an explicit call). */
function resizeInput(): void {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
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
    case 'set-title':
      // Keep the typed "/title " so the user can enter the session name,
      // then Enter posts setTitle with the args (see keydown handler).
      inputEl.value += '/title ';
      break;
    case 'status':
      post({ type: 'showStatus' });
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
  resizeInput();
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
    'No session yet — type a message below to start one. Type /help for commands.';
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
      state.remote = msg.remote;
      updateAttachAffordances();
      if (msg.sessionId !== state.sessionId) {
        // The chat window shows the current session's messages only — any
        // session switch (/new, /clear, delete-current, …) resets the view.
        state.lineage = null;
        renderMessages([]);
      }
      state.sessionId = msg.sessionId;
      state.syncReport = msg.syncReport;
      state.maxImageBytes = msg.maxImageBytes;
      state.maxImageDimension = msg.maxImageDimension;
      if (msg.slashCommands.length > 0) state.slashCommands = msg.slashCommands;
      connEl.textContent = msg.connected ? `● Hermes (${serverHost(msg.baseUrl)})` : `○ offline (${msg.baseUrl})`;
      connEl.style.color = msg.connected ? 'var(--vsh-accent)' : 'var(--vsh-error)';
      if (msg.connected && !msg.sessionId) {
        ensureNoSessionHint();
      } else {
        clearNoSessionHint();
      }
      renderSyncBanner(msg.syncReport);
      break;
    case 'session':
      // Session metadata — the model display moved to the status bar.
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
      dismissStaleApproval();
      break;
    case 'lineage':
      addLineageNote(msg.text);
      break;
    case 'info':
      addNote(msg.text);
      break;
    case 'error':
      addNote(msg.message, true);
      break;
    case 'model':
      // Model lock changes — the status bar reflects the active model.
      break;
    case 'fileResults':
      if (msg.query === state.fileQuery) {
        state.fileResults = msg.files;
        if (state.popupMode === 'file') updatePopup();
      }
      break;
    case 'browseResult':
      // OS picker for a plain reference (`@<path>`) — never copied.
      if (msg.path) {
        hideSlashPopup();
        inputEl.value = inputEl.value.slice(0, state.mentionStart) + `@${msg.path}`;
        resizeInput();
        inputEl.focus();
      }
      break;
    case 'insertTokens':
      appendTokens(msg.tokens);
      break;
  }
}

// ── wiring ─────────────────────────────────────────────────────────

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  onHostMessage(e.data);
});

inputEl.addEventListener('keydown', (e) => {
  if (popupVisible() && e.key !== 'Escape') {
    const fileMode = state.popupMode === 'file';
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (fileMode) state.fileIndex++;
      else state.slashIndex++;
      updatePopup();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (fileMode) state.fileIndex = Math.max(0, state.fileIndex - 1);
      else state.slashIndex = Math.max(0, state.slashIndex - 1);
      updatePopup();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (fileMode) {
        const f = filteredFiles()[state.fileIndex];
        if (f) selectFile(f.abs);
      } else {
        const items = filterSlash(state.slashQuery);
        const c = items[state.slashIndex];
        if (c) selectSlash(c);
      }
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const m = matchSlash(inputEl.value.trim());
    if (m && m.def && m.def.kind === 'action') {
      if (m.def.handler === 'set-title') {
        // "/title My Session" — post the args (empty args → host prompts).
        post({ type: 'setTitle', title: m.args });
        inputEl.value = '';
        return;
      }
      if (!m.args) {
        // "/new" etc. with no args — run the action instead of sending text.
        if (m.def.handler === 'new-session' || m.def.handler === 'clear-session' || m.def.handler === 'stop' || m.def.handler === 'history' || m.def.handler === 'help') {
          runSlashAction(m.def);
          inputEl.value = '';
          return;
        }
      }
    }
    void sendNow();
    return;
  }
  if (e.key === 'Escape') hideSlashPopup();
  if (e.key === ' ') updatePopup();
});

inputEl.addEventListener('input', () => {
  resizeInput();
  updatePopup();
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

/** Remote endpoints have no upload channel — file attach is disabled there.
 *  Images still work (sent inline over HTTP). */
function updateAttachAffordances(): void {
  attachBtn.disabled = state.remote;
  attachBtn.title = state.remote
    ? 'Attach disabled on remote endpoints — the gateway can\'t receive files'
    : 'Attach file(s) — copied into the session attachments';
}

// Drag & drop anywhere on the panel: images → chips (existing flow), any
// other file → attach token (`@file <path>`; the host copies it into
// attachments at send time). Two payload shapes:
//   - dataTransfer.files — real OS drops (local VS Code; File.path is set).
//     In remote/devcontainer workspaces VS Code strips local host files
//     from drops into webviews (a Mac path is meaningless in the
//     container), so files arrives empty — surface an honest note instead
//     of silence.
//   - text/uri-list — workbench-internal drags (Explorer tree etc.), i.e.
//     container-reachable file URIs. These become attach tokens directly.
document.addEventListener('dragover', (e) => {
  const types = e.dataTransfer?.types ?? [];
  if (types.includes('Files') || types.includes('text/uri-list')) {
    e.preventDefault();
    inputAreaEl.classList.add('dragover');
  }
});
document.addEventListener('dragleave', () => inputAreaEl.classList.remove('dragover'));
document.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  if (!dt) return;
  inputAreaEl.classList.remove('dragover');
  const files = Array.from(dt.files ?? []);
  if (files.length > 0) {
    e.preventDefault();
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        void addImageFile(f);
      } else if (state.remote) {
        addNote(
          'File attach isn\'t available on remote endpoints — the gateway can\'t receive files. Use the Endpoints panel (gear) to switch back to a local endpoint.',
          true,
        );
      } else {
        const p = (f as File & { path?: string }).path;
        if (p) appendTokens([`@file ${p}`]);
        else addNote(`Could not resolve the path for “${f.name}”.`, true);
      }
    }
    return;
  }
  // Workbench-internal drag (Explorer / tree views): file:// URIs.
  let uris = '';
  try {
    uris = dt.getData('text/uri-list') ?? '';
  } catch {
    uris = '';
  }
  const paths = uris
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('file:'))
    .map((l) => {
      try {
        return decodeURI(l.slice('file://'.length)).split('#')[0];
      } catch {
        return '';
      }
    })
    .filter((p) => p.length > 0);
  if (paths.length > 0) {
    e.preventDefault();
    if (state.remote) {
      addNote(
        'File attach isn\'t available on remote endpoints — the gateway can\'t receive files. Use the Endpoints panel (gear) to switch back to a local endpoint.',
        true,
      );
    } else {
      appendTokens(paths.map((p) => `@file ${p}`));
    }
    return;
  }
  // A drop with the Files type but an empty payload is a host-filesystem
  // drop that remote VS Code stripped — the container can never see it.
  if ((dt.types ?? []).includes('Files')) {
    e.preventDefault();
    addNote(
      'Files dragged from the host filesystem can\'t reach the container — use the attach button (paperclip), or drag the file into the Explorer first, then drag it from there.',
      true,
    );
  }
});

attachBtn.addEventListener('click', () => post({ type: 'attachDialog' }));

sendBtn.addEventListener('click', () => {
  if (state.streaming) {
    post({ type: 'stop' });
  } else {
    void sendNow();
  }
});

// ── init ───────────────────────────────────────────────────────────

updateRunUi();
updateAttachAffordances();
post({ type: 'ready' });
