/**
 * Endpoints panel smoke test — runs the SHIPPED bundle
 * (dist/media/endpoints.js) inside jsdom with a stub acquireVsCodeApi,
 * replicating the EndpointsPanel markup. Proves the panel boots, renders
 * profiles (incl. the Test button) and posts add/setKey/remove messages.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const BUNDLE = join(__dirname, '..', 'dist', 'media', 'endpoints.js');

const PANEL_HTML = `<!DOCTYPE html><html><body>
  <div id="status"></div>
  <div id="endpoint-list"></div>
  <div class="add">
    <input id="new-name">
    <input id="new-url">
    <button id="add-btn">Add</button>
  </div>
</body></html>`;

interface HostMsg {
  type: string;
  [k: string]: unknown;
}

function bootPanel(): { dom: JSDOM; sent: HostMsg[]; post: (m: HostMsg) => void } {
  const sent: HostMsg[] = [];
  const dom = new JSDOM(PANEL_HTML, {
    runScripts: 'dangerously',
    url: 'https://vscode-webview.test',
    beforeParse(window) {
      // Real VS Code contract: acquireVsCodeApi may only be called ONCE —
      // repeated calls throw. The stub enforces that so a bundle which
      // calls it per-message (the original bug) fails these tests.
      let calls = 0;
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => {
        calls += 1;
        if (calls > 1) throw new Error('acquireVsCodeApi can only be called once');
        return {
          postMessage: (m: HostMsg) => sent.push(m),
          getState: () => undefined,
          setState: () => undefined,
        };
      };
    },
  });
  const script = dom.window.document.createElement('script');
  script.textContent = readFileSync(BUNDLE, 'utf8');
  dom.window.document.body.appendChild(script);
  return {
    dom,
    sent,
    post: (m) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m })),
  };
}

describe('endpoints panel bundle (dist/media/endpoints.js)', () => {
  it('boots and posts ready', () => {
    const { sent } = bootPanel();
    expect(sent.some((m) => m.type === 'ready')).toBe(true);
  });

  it('shows key status per profile (no key → key ✓)', () => {
    const { dom, post } = bootPanel();
    const state = (keySet: string[]) =>
      ({
        type: 'state',
        endpoints: [{ id: 'e1', name: 'Home server', url: 'http://10.0.0.5:8642' }],
        activeId: null,
        keySet,
        remote: true,
        connected: false,
        baseUrl: 'http://10.0.0.5:8642',
        localUrl: 'http://127.0.0.1:8642',
      }) as unknown as HostMsg;
    post(state([]));
    const badge = dom.window.document.querySelector('.badge.key-badge');
    expect(badge?.textContent).toBe('no key');
    // Host refreshes state after Save key → badge flips.
    post(state(['e1']));
    expect(dom.window.document.querySelector('.badge.key-badge')?.textContent).toBe('key ✓');
  });

  it('Save key posts setKey, confirms in the status line, clears the field', () => {
    const { dom, sent, post } = bootPanel();
    post({
      type: 'state',
      endpoints: [{ id: 'e1', name: 'Home server', url: 'http://10.0.0.5:8642' }],
      activeId: null,
      keySet: [],
      remote: true,
      connected: false,
      baseUrl: 'http://10.0.0.5:8642',
      localUrl: 'http://127.0.0.1:8642',
    } as unknown as HostMsg);
    const input = dom.window.document.querySelector('.keyrow input') as HTMLInputElement;
    input.value = 'sekret-123';
    const saveBtn = Array.from(dom.window.document.querySelectorAll('button')).find((b) => b.textContent === 'Save key')!;
    saveBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(sent.some((m) => m.type === 'setKey' && (m as { key?: string }).key === 'sekret-123')).toBe(true);
    expect(dom.window.document.getElementById('status')?.textContent).toContain('Key saved for Home server');
    expect(input.value).toBe('');
  });

  it('renders a profile row with a Test button and badges', () => {
    const { dom, post } = bootPanel();
    post({
      type: 'state',
      endpoints: [{ id: 'e1', name: 'Home server', url: 'http://10.0.0.5:8642' }],
      activeId: null,
      keySet: [],
      remote: true,
      connected: false,
      baseUrl: 'http://10.0.0.5:8642',
      localUrl: 'http://127.0.0.1:8642',
    } as unknown as HostMsg);
    const rows = dom.window.document.querySelectorAll('.endpoint');
    expect(rows.length).toBe(2); // Local connection + profile
    const row = rows[1];
    expect(row.textContent).toContain('Home server');
    expect(row.textContent).toContain('remote');
    expect(Array.from(row.querySelectorAll('button')).some((b) => b.textContent === 'Test')).toBe(true);
    expect(Array.from(row.querySelectorAll('button')).some((b) => b.textContent === 'Activate')).toBe(true);
  });

  it('always renders the Local connection row first, active when no profile is', () => {
    const { dom, post } = bootPanel();
    post({
      type: 'state',
      endpoints: [{ id: 'e1', name: 'Home server', url: 'http://10.0.0.5:8642' }],
      activeId: null,
      keySet: [],
      remote: false,
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      localUrl: 'http://127.0.0.1:8642',
    } as unknown as HostMsg);
    const rows = dom.window.document.querySelectorAll('.endpoint');
    const local = rows[0];
    expect(local.textContent).toContain('Local connection');
    expect(local.classList.contains('active')).toBe(true);
    expect(local.textContent).toContain('legacy key');
    // Local has Test but no Save/Remove/key input.
    const buttons = Array.from(local.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Test');
    expect(buttons).not.toContain('Save');
    expect(buttons).not.toContain('Remove');
    expect(local.querySelector('.keyrow')).toBeNull();
    expect(Array.from(rows[1].querySelectorAll('button')).some((b) => b.textContent === 'Activate')).toBe(true);
  });

  it('activating the Local row posts setActive null', () => {
    const { dom, post, sent } = bootPanel();
    post({
      type: 'state',
      endpoints: [{ id: 'e1', name: 'Home server', url: 'http://10.0.0.5:8642' }],
      activeId: 'e1',
      keySet: [],
      remote: true,
      connected: true,
      baseUrl: 'http://10.0.0.5:8642',
      localUrl: 'http://127.0.0.1:8642',
    } as unknown as HostMsg);
    const local = dom.window.document.querySelectorAll('.endpoint')[0];
    const activate = Array.from(local.querySelectorAll('button')).find((b) => b.textContent === 'Activate')!;
    activate.click();
    const msg = sent.find((m) => m.type === 'setActive');
    expect((msg as unknown as { id: string | null }).id).toBeNull();
  });

  it('marks the active profile and hides its Activate button', () => {
    const { dom, post } = bootPanel();
    post({
      type: 'state',
      endpoints: [
        { id: 'e1', name: 'Local', url: 'http://127.0.0.1:8642' },
        { id: 'e2', name: 'Home server', url: 'http://10.0.0.5:8642' },
      ],
      activeId: 'e1',
      keySet: [],
      remote: false,
      connected: true,
      baseUrl: 'http://127.0.0.1:8642',
      localUrl: 'http://127.0.0.1:8642',
    } as unknown as HostMsg);
    const rows = dom.window.document.querySelectorAll('.endpoint');
    expect(rows.length).toBe(3); // Local + 2 profiles
    const profile = rows[1];
    expect(profile.classList.contains('active')).toBe(true);
    expect(profile.textContent).toContain('active');
    expect(Array.from(profile.querySelectorAll('button')).some((b) => b.textContent === 'Activate')).toBe(false);
    expect(Array.from(rows[2].querySelectorAll('button')).some((b) => b.textContent === 'Activate')).toBe(true);
  });

  it('Add posts an add message with trimmed name/url and clears the form', () => {
    const { dom, sent } = bootPanel();
    const name = dom.window.document.getElementById('new-name') as HTMLInputElement;
    const url = dom.window.document.getElementById('new-url') as HTMLInputElement;
    name.value = '  Home server  ';
    url.value = '  http://10.0.0.5:8642  ';
    (dom.window.document.getElementById('add-btn') as HTMLButtonElement).click();
    const add = sent.find((m) => m.type === 'add');
    expect(add).toBeDefined();
    expect((add as unknown as { name: string }).name).toBe('Home server');
    expect((add as unknown as { url: string }).url).toBe('http://10.0.0.5:8642');
    expect(name.value).toBe('');
    expect(url.value).toBe('');
  });

  it('Add with only a URL defaults the name to the host', () => {
    const { dom, sent } = bootPanel();
    const url = dom.window.document.getElementById('new-url') as HTMLInputElement;
    url.value = 'http://10.0.0.5:8642';
    (dom.window.document.getElementById('add-btn') as HTMLButtonElement).click();
    const add = sent.find((m) => m.type === 'add');
    expect((add as unknown as { name: string }).name).toBe('10.0.0.5');
  });

  it('Add with an empty URL shows a visible note and posts nothing', () => {
    const { dom, sent } = bootPanel();
    const name = dom.window.document.getElementById('new-name') as HTMLInputElement;
    name.value = 'Home server';
    (dom.window.document.getElementById('add-btn') as HTMLButtonElement).click();
    expect(sent.some((m) => m.type === 'add')).toBe(false);
    const status = dom.window.document.getElementById('status')!;
    expect(status.textContent).toContain('URL is required');
    expect(status.classList.contains('note')).toBe(true);
  });

  it('renders host notes in the status line', () => {
    const { dom, post } = bootPanel();
    post({ type: 'note', text: 'Invalid URL "nope" — include http:// or https://' } as unknown as HostMsg);
    const status = dom.window.document.getElementById('status')!;
    expect(status.textContent).toContain('Invalid URL');
  });

  it('renders test results under the profile', () => {
    const { dom, post } = bootPanel();
    post({
      type: 'state',
      endpoints: [{ id: 'e1', name: 'Home server', url: 'http://10.0.0.5:8642' }],
      activeId: null,
      keySet: [],
      remote: true,
      connected: false,
      baseUrl: 'http://10.0.0.5:8642',
      localUrl: 'http://127.0.0.1:8642',
    } as unknown as HostMsg);
    post({ type: 'testResult', id: 'e1', ok: false, detail: 'Unreachable: ECONNREFUSED' } as unknown as HostMsg);
    const row = dom.window.document.querySelectorAll('.endpoint')[1];
    expect(row.querySelector('.test-result')?.textContent).toContain('ECONNREFUSED');
  });
});
