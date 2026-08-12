/**
 * Home view bundle smoke test — runs dist/media/home.js in jsdom and
 * verifies the icon buttons post the right messages to the host.
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

describe('home view bundle (dist/media/home.js)', () => {
  it('boots and posts ready', () => {
    const { sent } = bootHome();
    expect(sent.some((m) => m.type === 'ready')).toBe(true);
  });

  it('renders one icon button per action (no text labels, no History)', () => {
    const { dom } = bootWithDom();
    const buttons = Array.from(dom.window.document.querySelectorAll('button.action'));
    const glyphs = buttons.map((b) => b.textContent);
    expect(glyphs).toEqual(['+', '⟳', '⚙', '🔑', '↻']);
    // Every button keeps its hover tooltip.
    for (const b of buttons) {
      expect((b as HTMLButtonElement).title.length).toBeGreaterThan(0);
    }
    // History is a sidebar tab now — the duplicate button is gone.
    expect(glyphs).not.toContain('☰');
  });

  it('New Chat button posts newSession', () => {
    const { sent, dom } = bootWithDom();
    clickAction(dom, '+');
    expect(sent.some((m) => m.type === 'newSession')).toBe(true);
  });

  it('Check Sync button posts checkSync', () => {
    const { sent, dom } = bootWithDom();
    clickAction(dom, '⟳');
    expect(sent.some((m) => m.type === 'checkSync')).toBe(true);
  });

  it('Refresh History button posts listSessions', () => {
    const { sent, dom } = bootWithDom();
    clickAction(dom, '↻');
    expect(sent.some((m) => m.type === 'listSessions')).toBe(true);
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

function clickAction(dom: JSDOM, glyph: string): void {
  const btn = Array.from(dom.window.document.querySelectorAll('button.action')).find(
    (b) => b.textContent === glyph,
  )!;
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}
