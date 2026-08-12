/**
 * Home view bundle smoke test — runs dist/media/home.js in jsdom and
 * verifies the icon dock posts the right messages to the host.
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

function bootHome(): { sent: HostMsg[]; dom: JSDOM } {
  const sent: HostMsg[] = [];
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="grid"></div></body></html>', {
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
  return { sent, dom };
}

describe('home view bundle (dist/media/home.js)', () => {
  it('boots and posts ready', () => {
    const { sent } = bootHome();
    expect(sent.some((m) => m.type === 'ready')).toBe(true);
  });

  it('renders exactly the icon dock (no status line, no note, no History)', () => {
    const { dom } = bootHome();
    const buttons = Array.from(dom.window.document.querySelectorAll('button.action'));
    expect(buttons.map((b) => b.textContent)).toEqual(['+', '⟳', '⚙', '🔑', '↻']);
    for (const b of buttons) {
      expect((b as HTMLButtonElement).title.length).toBeGreaterThan(0);
    }
    // Nothing but the grid — the tab fits the icons.
    const bodyText = dom.window.document.body.textContent ?? '';
    expect(bodyText).not.toContain('Connected');
    expect(bodyText).not.toContain('New actions will appear');
    expect(dom.window.document.getElementById('status')).toBeNull();
  });

  it('New Chat button posts newSession', () => {
    const { sent, dom } = bootHome();
    clickAction(dom, '+');
    expect(sent.some((m) => m.type === 'newSession')).toBe(true);
  });

  it('Check Sync button posts checkSync', () => {
    const { sent, dom } = bootHome();
    clickAction(dom, '⟳');
    expect(sent.some((m) => m.type === 'checkSync')).toBe(true);
  });

  it('Refresh History button posts listSessions', () => {
    const { sent, dom } = bootHome();
    clickAction(dom, '↻');
    expect(sent.some((m) => m.type === 'listSessions')).toBe(true);
  });
});

function clickAction(dom: JSDOM, glyph: string): void {
  const btn = Array.from(dom.window.document.querySelectorAll('button.action')).find(
    (b) => b.textContent === glyph,
  )!;
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}
