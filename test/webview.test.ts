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
    <div id="hint"></div>
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
