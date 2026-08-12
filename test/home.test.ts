/**
 * Home view bundle smoke test — runs dist/media/home.js in jsdom and
 * verifies the action buttons post the right messages to the host.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const BUNDLE = join(__dirname, '..', 'dist', 'media', 'home.js');

interface HostMsg {
  type: string;
  [k: string]: unknown;
}

function bootHome(): { sent: HostMsg[]; post: (msg: HostMsg) => void } {
  const sent: HostMsg[] = [];
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="status"></div><div id="grid"></div></body></html>', {
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
  return {
    sent,
    post: (m) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m })),
  };
}

function clickButton(sent: HostMsg[], label: string): void {
  void sent;
  void label;
  // Covered by clickAction against the live DOM in bootWithDom tests.
}

describe('home view bundle (dist/media/home.js)', () => {
  it('boots and posts ready', () => {
    const { sent } = bootHome();
    expect(sent.some((m) => m.type === 'ready')).toBe(true);
  });

  it('renders one button per action', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="status"></div><div id="grid"></div></body></html>', {
      runScripts: 'dangerously',
      url: 'https://vscode-webview.test',
      beforeParse(window) {
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
          postMessage: () => undefined,
          getState: () => undefined,
          setState: () => undefined,
        });
      },
    });
    const script = dom.window.document.createElement('script');
    script.textContent = readFileSync(BUNDLE, 'utf8');
    dom.window.document.body.appendChild(script);
    const buttons = Array.from(dom.window.document.querySelectorAll('button.action')).map((b) => b.textContent);
    expect(buttons).toContain('+ New Chat');
    expect(buttons).toContain('⟳ Check Sync');
    expect(buttons).toContain('⚙ Switch Model');
    expect(buttons).toContain('☰ History');
    expect(buttons).toContain('🔑 Set API Key');
    expect(buttons).toContain('⟳ Refresh History');
  });

  it('New Chat button posts newSession', () => {
    const { sent, dom } = bootWithDom();
    clickAction(dom, '+ New Chat');
    expect(sent.some((m) => m.type === 'newSession')).toBe(true);
  });

  it('Check Sync button posts checkSync', () => {
    const { sent, dom } = bootWithDom();
    clickAction(dom, '⟳ Check Sync');
    expect(sent.some((m) => m.type === 'checkSync')).toBe(true);
  });

  it('updates the status line from host state', () => {
    const { post, dom } = bootWithDom();
    post({
      type: 'state',
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      syncReport: null,
      sessionId: null,
      model: null,
      sessions: [],
      slashCommands: [],
      maxImageBytes: 0,
      maxImageDimension: 0,
    });
    const status = dom.window.document.getElementById('status')!;
    expect(status.textContent).toContain('Connected');
    expect(status.className).toContain('ok');
  });
});

function bootWithDom(): { sent: HostMsg[]; post: (msg: HostMsg) => void; dom: JSDOM } {
  const sent: HostMsg[] = [];
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="status"></div><div id="grid"></div></body></html>', {
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
  return { sent, post: (m) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m })), dom };
}

function clickAction(dom: JSDOM, label: string): void {
  const btn = Array.from(dom.window.document.querySelectorAll('button.action')).find(
    (b) => b.textContent === label,
  )!;
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}
