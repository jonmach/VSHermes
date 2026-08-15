/**
 * Webview smoke test — runs the SHIPPED bundle (dist/media/chat.js) inside
 * jsdom with a stub acquireVsCodeApi, replicating the chatProvider markup.
 * This proves the input UX logic (Enter=send, Shift+Enter=newline, button,
 * slash picker, host state rendering) works in a DOM — separating "webview
 * code is broken" from "webview didn't load in the real editor".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM, type DOMWindow } from 'jsdom';
import { describe, expect, it } from 'vitest';

const BUNDLE = join(__dirname, '..', 'dist', 'media', 'chat.js');

const WEBVIEW_HTML = `<!DOCTYPE html><html><body>
  <div id="sync-banner"></div>
  <div id="header">
    <span id="conn"></span>
    <span class="spacer"></span>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <div id="slash-popup"></div>
    <div id="approval"><div class="cmd" id="approval-cmd"></div>
      <button data-d="once"></button><button data-d="session"></button>
      <button data-d="always"></button><button data-d="deny"></button>
    </div>
    <div id="chips"></div>
    <textarea id="input"></textarea>
    <button id="attach-btn"></button>
    <button id="send-btn"></button>
  </div>
</body></html>`;

interface HostMsg {
  type: string;
  [k: string]: unknown;
}

function bootWebview(): { dom: JSDOM; sent: HostMsg[]; post: (msg: HostMsg) => void; input: HTMLTextAreaElement; sendBtn: HTMLButtonElement } {
  const sent: HostMsg[] = [];
  const dom = new JSDOM(WEBVIEW_HTML, {
    runScripts: 'dangerously',
    url: 'https://vscode-webview.test',
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (m: HostMsg) => sent.push(m),
        getState: () => undefined,
        setState: () => undefined,
      });
    },
  });
  const script = dom.window.document.createElement('script');
  script.textContent = readFileSync(BUNDLE, 'utf8');
  dom.window.document.body.appendChild(script);
  const input = dom.window.document.getElementById('input') as HTMLTextAreaElement;
  const sendBtn = dom.window.document.getElementById('send-btn') as HTMLButtonElement;
  return {
    dom,
    sent,
    post: (m) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m })),
    input,
    sendBtn,
  };
}

function keydown(win: DOMWindow, key: string, shift = false): void {
  const input = win.document.getElementById('input') as HTMLTextAreaElement;
  input.dispatchEvent(
    new win.KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }),
  );
}

describe('webview bundle (dist/media/chat.js)', () => {
  it('boots and posts ready', () => {
    const { sent } = bootWebview();
    expect(sent.some((m) => m.type === 'ready')).toBe(true);
  });

  it('Enter sends a text message', () => {
    const { dom, sent, input } = bootWebview();
    input.value = 'hello hermes';
    keydown(dom.window, 'Enter');
    const send = sent.find((m) => m.type === 'send');
    expect(send).toBeDefined();
    expect(send!.parts).toEqual([{ type: 'text', text: 'hello hermes' }]);
  });

  it('Shift+Enter does NOT send (newline)', () => {
    const { dom, sent, input } = bootWebview();
    input.value = 'line one';
    keydown(dom.window, 'Enter', true);
    expect(sent.some((m) => m.type === 'send')).toBe(false);
  });

  it('/title with args posts setTitle on Enter (not sent as text)', () => {
    const { dom, sent, input } = bootWebview();
    input.value = '/title My Session';
    keydown(dom.window, 'Enter');
    const m = sent.find((x) => x.type === 'setTitle');
    expect(m).toBeDefined();
    expect((m as unknown as { title: string }).title).toBe('My Session');
    expect(sent.some((x) => x.type === 'send')).toBe(false);
  });

  it('/title without args still posts setTitle (host prompts)', () => {
    const { dom, sent, input } = bootWebview();
    input.value = '/title';
    keydown(dom.window, 'Enter');
    const m = sent.find((x) => x.type === 'setTitle');
    expect(m).toBeDefined();
    expect((m as unknown as { title: string }).title).toBe('');
  });

  it('send button transmits the message', () => {
    const { dom, sent, input, sendBtn } = bootWebview();
    input.value = 'via button';
    sendBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const send = sent.find((m) => m.type === 'send');
    expect(send).toBeDefined();
    expect((send!.parts as Array<{ text?: string }>)[0].text).toBe('via button');
  });

  it('renders host state and shows a start hint when there is no session', () => {
    const { dom, post } = bootWebview();
    post({
      type: 'state',
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      syncReport: null,
      sessionId: null,
      model: 'hermes-agent',
      sessions: [],
      slashCommands: [],
      maxImageBytes: 8388608,
      maxImageDimension: 4096,
    });
    const conn = dom.window.document.getElementById('conn')!;
    expect(conn.textContent).toContain('Hermes');
    expect(dom.window.document.getElementById('no-session-hint')).not.toBeNull();
  });

  it('shows the connected server (host:port) in the header badge', () => {
    const { dom, post } = bootWebview();
    post({
      type: 'state',
      connected: true,
      baseUrl: 'http://10.0.0.5:8642',
      syncReport: null,
      sessionId: null,
      model: 'hermes-agent',
      sessions: [],
      slashCommands: [],
      maxImageBytes: 8388608,
      maxImageDimension: 4096,
    });
    const conn = dom.window.document.getElementById('conn')!;
    expect(conn.textContent).toContain('10.0.0.5:8642');
  });

  it('removes the start hint once a session is active', () => {
    const { dom, post } = bootWebview();
    post({
      type: 'state',
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      syncReport: null,
      sessionId: null,
      model: 'hermes-agent',
      sessions: [],
      slashCommands: [],
      maxImageBytes: 8388608,
      maxImageDimension: 4096,
    });
    expect(dom.window.document.getElementById('no-session-hint')).not.toBeNull();
    post({
      type: 'state',
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      syncReport: null,
      sessionId: 'api_1',
      model: 'hermes-agent',
      sessions: [],
      slashCommands: [],
      maxImageBytes: 8388608,
      maxImageDimension: 4096,
    });
    expect(dom.window.document.getElementById('no-session-hint')).toBeNull();
  });

  it('/new (state with a different sessionId) clears the message list', () => {
    const { dom, post } = bootWebview();
    const base = {
      type: 'state',
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      syncReport: null,
      sessions: [],
      slashCommands: [],
      maxImageBytes: 8388608,
      maxImageDimension: 4096,
    };
    post({ ...base, sessionId: 's1', model: 'm1' } as unknown as HostMsg);
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [{ role: 'user', content: 'hello old session' }],
    } as unknown as HostMsg);
    const messages = dom.window.document.getElementById('messages')!;
    expect(messages.textContent).toContain('hello old session');
    // /new → host creates a new session and posts state with the new id
    post({ ...base, sessionId: 's2', model: 'm1' } as unknown as HostMsg);
    expect(messages.textContent).not.toContain('hello old session');
  });

  it('keeps the message list when state repeats the same sessionId', () => {
    const { dom, post } = bootWebview();
    const base = {
      type: 'state',
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      syncReport: null,
      sessions: [],
      slashCommands: [],
      maxImageBytes: 8388608,
      maxImageDimension: 4096,
    };
    post({ ...base, sessionId: 's1', model: 'm1' } as unknown as HostMsg);
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [{ role: 'user', content: 'stays put' }],
    } as unknown as HostMsg);
    // e.g. a sync re-check posts state again for the same session
    post({ ...base, sessionId: 's1', model: 'm1' } as unknown as HostMsg);
    expect(dom.window.document.getElementById('messages')!.textContent).toContain('stays put');
  });

  it('renders a per-turn usage line from run.completed.usage', () => {
    const { dom, post } = bootWebview();
    const base = {
      type: 'state',
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      syncReport: null,
      sessionId: 's1',
      model: 'm1',
      sessions: [],
      slashCommands: [],
      maxImageBytes: 8388608,
      maxImageDimension: 4096,
    };
    post(base as unknown as HostMsg);
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [{ role: 'user', content: 'hello' }],
    } as unknown as HostMsg);
    // streaming turn → run.completed with usage
    post({
      type: 'stream',
      event: { type: 'run.started', session_id: 's1' },
    } as unknown as HostMsg);
    post({
      type: 'stream',
      event: { type: 'message.started', session_id: 's1', message: { id: 'm1', role: 'assistant' } },
    } as unknown as HostMsg);
    post({
      type: 'stream',
      event: { type: 'assistant.delta', session_id: 's1', message_id: 'm1', delta: 'hi there' },
    } as unknown as HostMsg);
    post({
      type: 'stream',
      event: {
        type: 'run.completed',
        session_id: 's1',
        message_id: 'm1',
        completed: true,
        messages: [],
        usage: { input_tokens: 1234, output_tokens: 56, total_tokens: 1290 },
      },
    } as unknown as HostMsg);
    const messages = dom.window.document.getElementById('messages')!;
    expect(messages.textContent).toContain('1.2k in');
    expect(messages.textContent).toContain('56 out');
    expect(messages.textContent).toContain('1.3k total');
    expect(messages.querySelector('.usage-line')).not.toBeNull();
  });

  it('pins a lineage notice above the transcript and clears it on session switch', () => {
    const { dom, post } = bootWebview();
    const base = {
      type: 'state',
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      syncReport: null,
      sessions: [],
      slashCommands: [],
      maxImageBytes: 8388608,
      maxImageDimension: 4096,
    };
    post({ ...base, sessionId: 's1', model: 'm1' } as unknown as HostMsg);
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [{ role: 'user', content: 'parent transcript' }],
    } as unknown as HostMsg);
    post({ type: 'lineage', text: 'This session continues after context compression' } as unknown as HostMsg);
    const messages = dom.window.document.getElementById('messages')!;
    expect(messages.querySelector('.lineage-note')?.textContent).toContain('context compression');
    // transcript sits BELOW the notice
    const note = messages.querySelector('.lineage-note')!;
    const transcriptMsg = Array.from(messages.children).find((c) => c.textContent?.includes('parent transcript'))!;
    expect(note.compareDocumentPosition(transcriptMsg) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // switching sessions clears the stale notice
    post({ ...base, sessionId: 's2', model: 'm1' } as unknown as HostMsg);
    expect(messages.querySelector('.lineage-note')).toBeNull();
  });

  it('clears the list and shows the start hint when the current session is deleted', () => {
    const { dom, post } = bootWebview();
    const base = {
      type: 'state',
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      syncReport: null,
      sessions: [],
      slashCommands: [],
      maxImageBytes: 8388608,
      maxImageDimension: 4096,
    };
    post({ ...base, sessionId: 's1', model: 'm1' } as unknown as HostMsg);
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [{ role: 'user', content: 'bye bye' }],
    } as unknown as HostMsg);
    expect(dom.window.document.getElementById('messages')!.textContent).toContain('bye bye');
    // deleteSession on the current session → state with sessionId null
    post({ ...base, sessionId: null, model: null } as unknown as HostMsg);
    expect(dom.window.document.getElementById('messages')!.textContent).not.toContain('bye bye');
    expect(dom.window.document.getElementById('no-session-hint')).not.toBeNull();
  });

  it('send button stays clickable while streaming and clicks post stop', () => {
    const { dom, sent, post, sendBtn } = bootWebview();
    post({ type: 'stream', event: { type: 'run.started' } } as unknown as HostMsg);
    expect(sendBtn.disabled).toBe(false);
    expect(sendBtn.textContent).toContain('■');
    sendBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(sent.some((m) => m.type === 'stop')).toBe(true);
    expect(sent.some((m) => m.type === 'send')).toBe(false);
  });

  it('adds hover copy buttons to user and assistant message bubbles', () => {
    const { dom, post } = bootWebview();
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'my question' },
        { role: 'assistant', content: 'an answer' },
      ],
    } as unknown as HostMsg);
    const msgs = dom.window.document.querySelectorAll('#messages .msg');
    expect(msgs.length).toBe(2);
    msgs.forEach((m) => {
      // Copy button lives beside the bubble in a flex row, not at row level.
      expect(m.querySelector('.bubble-row')).not.toBeNull();
      expect(m.querySelector('.bubble-row .msg-copy')).not.toBeNull();
    });
    // Clicking must not throw even without a real clipboard (jsdom).
    const btn = msgs[0].querySelector('.msg-copy') as HTMLButtonElement;
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  it('adds a copy button to tool card output', () => {
    const { dom, post } = bootWebview();
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [
        {
          role: 'assistant',
          content: 'done',
          tool_calls: [{ function: { name: 'patch', arguments: '{"file":"a.txt"}' } }],
        },
      ],
    } as unknown as HostMsg);
    const card = dom.window.document.querySelector('.tool-card');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.tool-copy')).not.toBeNull();
  });

  it('keeps the tool copy button across streaming progress updates', () => {
    const { dom, post } = bootWebview();
    post({ type: 'stream', event: { type: 'run.started' } } as unknown as HostMsg);
    post({ type: 'stream', event: { type: 'message.started' } } as unknown as HostMsg);
    post({
      type: 'stream',
      event: { type: 'tool.started', tool_name: 'terminal', preview: 'first line' },
    } as unknown as HostMsg);
    post({
      type: 'stream',
      event: { type: 'tool.progress', tool_name: 'terminal', delta: '\nmore output' },
    } as unknown as HostMsg);
    const card = dom.window.document.querySelector('.tool-card');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.tool-copy')).not.toBeNull();
  });

  it('@ opens the file picker and inserts a plain reference on selection', async () => {
    const { dom, sent, post, input } = bootWebview();
    input.value = '@';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(dom.window.document.getElementById('slash-popup')!.classList.contains('show')).toBe(true);
    // The host query is debounced 250ms.
    await new Promise((r) => setTimeout(r, 300));
    const q = sent.find((m) => m.type === 'fileQuery');
    expect(q).toBeDefined();
    expect((q as unknown as { query: string }).query).toBe('');
    post({
      type: 'fileResults',
      query: '',
      files: [
        { rel: 'src/foo.ts', abs: '/ws/src/foo.ts' },
        { rel: 'src/bar.ts', abs: '/ws/src/bar.ts' },
      ],
    } as unknown as HostMsg);
    const items = dom.window.document.querySelectorAll('#slash-popup .slash-item');
    expect(items.length).toBe(3); // 2 files + Browse… row
    expect(items[0].textContent).toContain('src/foo.ts');
    expect(items[0].textContent).toContain('@src/foo.ts'); // reference form label
    expect(items[2].textContent).toContain('Browse');
    // Enter selects the highlighted file (absolute path) and closes the popup.
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(input.value).toBe('@/ws/src/foo.ts');
    expect(dom.window.document.getElementById('slash-popup')!.classList.contains('show')).toBe(false);
  });

  it('@file prefix selects the attach form (inserts @file <abs>)', async () => {
    const { dom, sent, post, input } = bootWebview();
    input.value = '@file ';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(dom.window.document.getElementById('slash-popup')!.classList.contains('show')).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    post({
      type: 'fileResults',
      query: '',
      files: [{ rel: 'data/report.pdf', abs: '/ws/data/report.pdf' }],
    } as unknown as HostMsg);
    const items = dom.window.document.querySelectorAll('#slash-popup .slash-item');
    expect(items[0].textContent).toContain('@file data/report.pdf'); // attach form label
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(input.value).toBe('@file /ws/data/report.pdf');
    expect(sent.some((m) => m.type === 'fileQuery')).toBe(true);
  });

  it('@ works mid-line and replaces only the mention token', async () => {
    const { dom, sent, post, input } = bootWebview();
    input.value = 'please check @CHAN';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(dom.window.document.getElementById('slash-popup')!.classList.contains('show')).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    const q = sent.find((m) => m.type === 'fileQuery');
    expect((q as unknown as { query: string }).query).toBe('CHAN');
    post({
      type: 'fileResults',
      query: 'CHAN',
      files: [{ rel: 'CHANGELOG.md', abs: '/ws/CHANGELOG.md' }],
    } as unknown as HostMsg);
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(input.value).toBe('please check @/ws/CHANGELOG.md');
  });

  it('Browse… row posts browse; browseResult inserts a @<path> reference', async () => {
    const { dom, sent, post, input } = bootWebview();
    input.value = 'look at @';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    post({ type: 'fileResults', query: '', files: [] } as unknown as HostMsg);
    const items = dom.window.document.querySelectorAll('#slash-popup .slash-item');
    const browse = Array.from(items).find((el) => el.textContent?.includes('Browse'));
    expect(browse).toBeDefined();
    (browse as HTMLElement).click();
    expect(sent.some((m) => m.type === 'browse')).toBe(true);
    post({ type: 'browseResult', path: '/opt/data/archive' } as unknown as HostMsg);
    expect(input.value).toBe('look at @/opt/data/archive');
  });

  it('insertTokens appends @file tokens on their own lines', () => {
    const { dom, post, input } = bootWebview();
    input.value = 'check this';
    post({ type: 'insertTokens', tokens: ['@file /tmp/a.zip', '@file /tmp/b.pdf'] } as unknown as HostMsg);
    expect(input.value).toBe('check this\n@file /tmp/a.zip\n@file /tmp/b.pdf');
    post({ type: 'insertTokens', tokens: ['@file /tmp/c.csv'] } as unknown as HostMsg);
    expect(input.value).toBe('check this\n@file /tmp/a.zip\n@file /tmp/b.pdf\n@file /tmp/c.csv');
  });

  it('dropping a non-image file appends an @file attach token', () => {
    const { dom, input } = bootWebview();
    const file = { name: 'bundle.zip', type: 'application/zip', path: '/tmp/bundle.zip' };
    const ev = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
    dom.window.document.dispatchEvent(ev);
    expect(input.value).toBe('@file /tmp/bundle.zip');
  });

  it('dropping a file from the Explorer (text/uri-list) appends attach tokens', () => {
    const { dom, input } = bootWebview();
    const uris = 'file:///workspace/src/extension.ts\r\nfile:///workspace/README.md\r\n';
    const ev = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: { files: [], types: ['text/uri-list'], getData: (t: string) => (t === 'text/uri-list' ? uris : '') },
    });
    dom.window.document.dispatchEvent(ev);
    expect(input.value).toBe('@file /workspace/src/extension.ts\n@file /workspace/README.md');
  });

  it('decodes and strips fragments from uri-list entries', () => {
    const { dom, input } = bootWebview();
    const uris = 'file:///workspace/my%20file.txt#L3,5\r\n';
    const ev = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: { files: [], types: ['text/uri-list'], getData: (t: string) => (t === 'text/uri-list' ? uris : '') },
    });
    dom.window.document.dispatchEvent(ev);
    expect(input.value).toBe('@file /workspace/my file.txt');
  });

  it('a host-filesystem drop stripped by remote VS Code shows a note, not silence', () => {
    const { dom, input } = bootWebview();
    const ev = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: { files: [], types: ['Files'], getData: () => '' },
    });
    dom.window.document.dispatchEvent(ev);
    expect(input.value).toBe('');
    const messages = dom.window.document.getElementById('messages')!;
    expect(messages.textContent).toContain('host filesystem');
    expect(messages.textContent).toContain('paperclip');
  });

  it('dropping an image file does not insert an attach token (chips flow)', () => {
    const { dom, input } = bootWebview();
    const file = { name: 'pixel.png', type: 'image/png', path: '/tmp/pixel.png' };
    const ev = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [file] } });
    dom.window.document.dispatchEvent(ev);
    expect(input.value).toBe('');
  });

  it('attach button posts attachDialog', () => {
    const { dom, sent } = bootWebview();
    const btn = dom.window.document.getElementById('attach-btn') as HTMLButtonElement;
    btn.click();
    expect(sent.some((m) => m.type === 'attachDialog')).toBe(true);
  });

  it('remote endpoint: attach button is disabled with an explanatory tooltip', () => {
    const { dom, post } = bootWebview();
    post({ type: 'state', remote: true, baseUrl: 'http://10.0.0.5:8642' } as unknown as HostMsg);
    const btn = dom.window.document.getElementById('attach-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('remote');
  });

  it('remote endpoint: dropping a non-image file shows a note, no token', () => {
    const { dom, post, input } = bootWebview();
    post({ type: 'state', remote: true, baseUrl: 'http://10.0.0.5:8642' } as unknown as HostMsg);
    const file = { name: 'bundle.zip', type: 'application/zip', path: '/tmp/bundle.zip' };
    const ev = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
    dom.window.document.dispatchEvent(ev);
    expect(input.value).toBe('');
    expect(dom.window.document.getElementById('messages')!.textContent).toContain('remote endpoints');
  });

  it('remote endpoint: Explorer drag (uri-list) is blocked with a note', () => {
    const { dom, post, input } = bootWebview();
    post({ type: 'state', remote: true, baseUrl: 'http://10.0.0.5:8642' } as unknown as HostMsg);
    const uris = 'file:///workspace/src/extension.ts\r\n';
    const ev = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: { files: [], types: ['text/uri-list'], getData: (t: string) => (t === 'text/uri-list' ? uris : '') },
    });
    dom.window.document.dispatchEvent(ev);
    expect(input.value).toBe('');
    expect(dom.window.document.getElementById('messages')!.textContent).toContain('remote endpoints');
  });

  it('remote endpoint: dropped images still flow to chips (inline mode)', () => {
    const { dom, post, input } = bootWebview();
    post({ type: 'state', remote: true, baseUrl: 'http://10.0.0.5:8642' } as unknown as HostMsg);
    const file = { name: 'pixel.png', type: 'image/png', path: '/tmp/pixel.png' };
    const ev = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
    dom.window.document.dispatchEvent(ev);
    expect(input.value).toBe('');
    expect(dom.window.document.getElementById('messages')!.textContent).not.toContain('remote endpoints');
  });

  it('adds a copy button to the thinking block', () => {
    const { dom, post } = bootWebview();
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [{ role: 'assistant', content: 'answer', reasoning_content: 'hidden chain of thought' }],
    } as unknown as HostMsg);
    const t = dom.window.document.querySelector('.thinking');
    expect(t).not.toBeNull();
    expect(t!.querySelector('.thinking-copy')).not.toBeNull();
  });

  it('adds a copy button to rendered code blocks', () => {
    const { dom, post } = bootWebview();
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [{ role: 'assistant', content: '```js\nconst x = 1;\n```' }],
    } as unknown as HostMsg);
    const pre = dom.window.document.querySelector('#messages pre');
    expect(pre).not.toBeNull();
    expect(pre!.querySelector('.copy-btn')).not.toBeNull();
  });

  it('stream:ended without error does not surface an error note', () => {
    const { dom, post } = bootWebview();
    post({ type: 'stream', event: { type: 'run.started' } } as unknown as HostMsg);
    post({ type: 'stream:ended', sessionId: 's1' } as unknown as HostMsg);
    const messages = dom.window.document.getElementById('messages')!;
    expect(messages.textContent.toLowerCase()).not.toContain('error');
    expect(messages.textContent.toLowerCase()).not.toContain('aborted');
  });

  it('renders the sync banner for an outdated report', () => {
    const { dom, post } = bootWebview();
    post({
      type: 'sync',
      report: {
        status: 'outdated',
        checkedAt: Date.now(),
        hermesVersion: '0.18.0',
        pluginVersion: '0.1.0',
        pluginMinVersion: '0.20.0',
        versionCompare: -1,
        missingRequiredFeatures: ['session_chat_streaming'],
        missingRequiredEndpoints: [],
        unknownFeatures: [],
        presentOptionalFeatures: [],
        messages: ['Hermes 0.18.0 — 1 of 15 features VSHermes needs are unavailable: session_chat_streaming. Upgrade Hermes to 0.20.0+.'],
      },
    });
    const banner = dom.window.document.getElementById('sync-banner')!;
    expect(banner.classList.contains('show')).toBe(true);
    expect(banner.textContent).toContain('Upgrade Hermes to');
  });

  it('renders the sync banner for an OK report (visible confirmation)', () => {
    const { dom, post } = bootWebview();
    post({
      type: 'sync',
      report: {
        status: 'ok',
        checkedAt: Date.now(),
        hermesVersion: '0.20.0',
        pluginVersion: '0.1.0',
        pluginMinVersion: '0.20.0',
        versionCompare: 0,
        missingRequiredFeatures: [],
        missingRequiredEndpoints: [],
        unknownFeatures: [],
        presentOptionalFeatures: [],
        messages: ['Aligned with Hermes 0.20.0.'],
      },
    });
    const banner = dom.window.document.getElementById('sync-banner')!;
    expect(banner.classList.contains('show')).toBe(true);
    expect(banner.classList.contains('ok')).toBe(true);
    expect(banner.textContent).toContain('VSHermes 0.1.0 · Hermes 0.20.0');
    expect(banner.textContent).not.toContain('all features available');
  });

  it('renders the sync banner green for an untested report (version below minimum, nothing missing)', () => {
    const { dom, post } = bootWebview();
    post({
      type: 'sync',
      report: {
        status: 'untested',
        checkedAt: Date.now(),
        hermesVersion: '0.18.0',
        pluginVersion: '0.1.0',
        pluginMinVersion: '0.20.0',
        versionCompare: -1,
        missingRequiredFeatures: [],
        missingRequiredEndpoints: [],
        unknownFeatures: [],
        presentOptionalFeatures: [],
        messages: ['Hermes 0.18.0 is older than the version VSHermes 0.1.0 was verified against (0.20.0)'],
      },
    });
    const banner = dom.window.document.getElementById('sync-banner')!;
    expect(banner.classList.contains('show')).toBe(true);
    expect(banner.classList.contains('ok')).toBe(true);
    expect(banner.textContent).toContain('below the verified minimum');
  });

  it('open slash picker on / and select an action', () => {
    const { dom, sent, input } = bootWebview();
    input.value = '/new';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const popup = dom.window.document.getElementById('slash-popup')!;
    expect(popup.classList.contains('show')).toBe(true);
    // select the first item (Enter on the popup)
    keydown(dom.window, 'Enter');
    expect(sent.some((m) => m.type === 'newSession')).toBe(true);
  });
});
