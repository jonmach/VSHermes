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
    <span id="model-badge" class="model-badge"></span>
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

  it('@ opens the file picker and inserts @file on selection', async () => {
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
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('src/foo.ts');
    // Enter selects the highlighted file (absolute path) and closes the popup.
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(input.value).toBe('@file /ws/src/foo.ts');
    expect(dom.window.document.getElementById('slash-popup')!.classList.contains('show')).toBe(false);
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
    expect(input.value).toBe('please check @file /ws/CHANGELOG.md');
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
        messages: ['Hermes is missing capabilities the plugin requires'],
      },
    });
    const banner = dom.window.document.getElementById('sync-banner')!;
    expect(banner.classList.contains('show')).toBe(true);
    expect(banner.textContent).toContain('out of sync');
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
    expect(banner.textContent).toContain('In sync with Hermes 0.20.0');
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
