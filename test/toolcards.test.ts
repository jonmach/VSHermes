import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

/**
 * Tool-call visibility regression tests — runs the SHIPPED bundle
 * (dist/media/chat.js) in jsdom.
 *
 * Live-stream path: the exact SSE event sequence the Hermes API server
 * emits for a tool-using run (verified live: run.started, message.started,
 * tool.started, tool.completed, assistant.delta…) must render tool cards.
 * Stored path: a transcript fetched via GET /api/sessions/{id}/messages
 * carries OpenAI-style tool_calls ({id, type:"function",
 * function:{name, arguments}}) — those must render as done cards too.
 */

const BUNDLE = join(__dirname, '..', 'dist', 'media', 'chat.js');

const WEBVIEW_HTML = `<!DOCTYPE html><html><body>
  <div id="sync-banner"></div>
  <div id="header"><span id="conn"></span><span class="spacer"></span></div>
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

function boot(): { dom: JSDOM; post: (m: unknown) => void } {
  const dom = new JSDOM(WEBVIEW_HTML, {
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
  return {
    dom,
    post: (m) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m })),
  };
}

describe('webview tool-call visibility (dist/media/chat.js)', () => {
  it('renders live tool cards from the API server stream sequence', () => {
    const { dom, post } = boot();
    post({ type: 'stream', event: { type: 'run.started', session_id: 's' } });
    post({
      type: 'stream',
      event: { type: 'message.started', session_id: 's', message: { id: 'm1', role: 'assistant' } },
    });
    post({
      type: 'stream',
      event: {
        type: 'tool.started',
        session_id: 's',
        message_id: 'm1',
        tool_name: 'read_file',
        preview: 'package.json',
        args: null,
      },
    });
    post({
      type: 'stream',
      event: {
        type: 'tool.completed',
        session_id: 's',
        message_id: 'm1',
        tool_name: 'read_file',
        preview: null,
        args: null,
      },
    });
    post({ type: 'stream', event: { type: 'assistant.delta', session_id: 's', message_id: 'm1', delta: 'The version is 2.0.3.' } });

    const cards = dom.window.document.querySelectorAll('.tool-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('read_file');
    expect(cards[0].textContent).toContain('package.json');
    expect(cards[0].textContent).toContain('done');
  });

  it('renders tool cards from stored messages with the real server tool_calls shape', () => {
    const { dom, post } = boot();
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'check the version' },
        {
          role: 'assistant',
          id: 'm1',
          content: 'The version is 2.0.3.',
          tool_calls: [
            {
              id: 'call_00_abc123',
              call_id: 'call_00_abc123',
              response_item_id: 'fc_00_abc123',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path": "/workspace/projects/VSHermes/package.json"}' },
            },
          ],
        },
      ],
    });
    const cards = dom.window.document.querySelectorAll('.tool-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('read_file');
    expect(cards[0].textContent).toContain('done');
    expect(cards[0].textContent).toContain('/workspace/projects/VSHermes/package.json');
  });

  it('marks a tool card as failed when the server emits tool.failed', () => {
    const { dom, post } = boot();
    post({ type: 'stream', event: { type: 'run.started', session_id: 's' } });
    post({
      type: 'stream',
      event: { type: 'message.started', session_id: 's', message: { id: 'm1', role: 'assistant' } },
    });
    post({
      type: 'stream',
      event: {
        type: 'tool.started',
        session_id: 's',
        message_id: 'm1',
        tool_name: 'read_file',
        preview: null,
        args: null,
      },
    });
    post({
      type: 'stream',
      event: {
        type: 'tool.failed',
        session_id: 's',
        message_id: 'm1',
        tool_name: 'read_file',
        preview: null,
        args: null,
      },
    });
    const cards = dom.window.document.querySelectorAll('.tool-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('read_file');
    expect(cards[0].textContent).toContain('failed');
    expect(cards[0].classList.contains('failed')).toBe(true);
  });

  it('classifies a stored terminal failure (exit code) as a failed red card', () => {
    const { dom, post } = boot();
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'list the missing dir' },
        {
          role: 'assistant',
          id: 'm1',
          content: '',
          tool_calls: [
            {
              id: 'call_00_term1',
              call_id: 'call_00_term1',
              type: 'function',
              function: { name: 'terminal', arguments: '{"command": "ls /definitely/not/a/real/path"}' },
            },
          ],
        },
        {
          role: 'tool',
          id: 't1',
          tool_call_id: 'call_00_term1',
          tool_name: 'terminal',
          content: JSON.stringify({ output: "ls: cannot access '/definitely/not/a/real/path': No such file or directory", exit_code: 2, error: null }),
        },
      ],
    });
    const cards = dom.window.document.querySelectorAll('.tool-card');
    expect(cards.length).toBe(1);
    expect(cards[0].classList.contains('failed')).toBe(true);
    expect(cards[0].textContent).toContain('failed [exit 2]');
    expect(cards[0].querySelector('.terr')!.textContent).toContain('exit 2');
  });

  it('classifies a structured error result (read_file missing) as failed with the trimmed message', () => {
    const { dom, post } = boot();
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          id: 'm1',
          content: '',
          tool_calls: [
            {
              id: 'call_00_read1',
              call_id: 'call_00_read1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path": "/very/long/absolute/path/foo.py"}' },
            },
          ],
        },
        {
          role: 'tool',
          id: 't1',
          tool_call_id: 'call_00_read1',
          tool_name: 'read_file',
          content: JSON.stringify({ success: false, error: 'File not found: /very/long/absolute/path/foo.py' }),
        },
      ],
    });
    const cards = dom.window.document.querySelectorAll('.tool-card');
    expect(cards.length).toBe(1);
    expect(cards[0].classList.contains('failed')).toBe(true);
    // Path collapses to the filename, mirroring the server's _trim_error.
    expect(cards[0].textContent).toContain('File not found: foo.py');
    expect(cards[0].querySelector('.terr')!.textContent).toContain('File not found: /very/long/absolute/path/foo.py');
  });

  it('leaves a successful stored tool result as a plain done card', () => {
    const { dom, post } = boot();
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'check the version' },
        {
          role: 'assistant',
          id: 'm1',
          content: 'The version is 2.0.3.',
          tool_calls: [
            {
              id: 'call_00_ok1',
              call_id: 'call_00_ok1',
              type: 'function',
              function: { name: 'terminal', arguments: '{"command": "cat package.json"}' },
            },
          ],
        },
        {
          role: 'tool',
          id: 't1',
          tool_call_id: 'call_00_ok1',
          tool_name: 'terminal',
          content: JSON.stringify({ output: '{"version": "2.0.3"}', exit_code: 0, error: null }),
        },
      ],
    });
    const cards = dom.window.document.querySelectorAll('.tool-card');
    expect(cards.length).toBe(1);
    expect(cards[0].classList.contains('failed')).toBe(false);
    expect(cards[0].textContent).toContain('done');
  });

  it('renders a per-tool icon and a live duration suffix on the card', () => {
    const { dom, post } = boot();
    post({ type: 'stream', event: { type: 'run.started', session_id: 's' } });
    post({
      type: 'stream',
      event: { type: 'message.started', session_id: 's', message: { id: 'm1', role: 'assistant' } },
    });
    post({
      type: 'stream',
      event: {
        type: 'tool.started',
        session_id: 's',
        message_id: 'm1',
        tool_name: 'terminal',
        preview: 'ls -la',
        args: null,
      },
    });
    post({
      type: 'stream',
      event: {
        type: 'tool.completed',
        session_id: 's',
        message_id: 'm1',
        tool_name: 'terminal',
        preview: null,
        args: null,
      },
    });
    const cards = dom.window.document.querySelectorAll('.tool-card');
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector('.ticon')!.textContent).toBe('💻');
    // Duration suffix: "done · 0.x s" (jsdom runs instantly, so 0.x).
    expect(cards[0].textContent).toMatch(/done · \d+(\.\d+)?s/);
  });

  it('keeps scroll position when a transcript refresh appends content', () => {
    const { dom, post } = boot();
    const messagesEl = dom.window.document.getElementById('messages') as HTMLElement;
    // jsdom reports 0 layout metrics, so "at bottom" is always true there;
    // simulate a scrolled-up reader by faking scroll metrics before the
    // refresh arrives.
    Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(messagesEl, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(messagesEl, 'scrollTop', { configurable: true, value: 3000, writable: true });

    post({ type: 'messages', sessionId: 's1', messages: [{ role: 'user', content: 'a' }] });
    // User reading at 3000/5000 — not at bottom (5000-3000-500 = 1500 ≥ 60).
    // A refresh appending one message (height +100) must keep ~3000..3100,
    // not jump to the bottom (4500).
    Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, value: 5100 });
    post({
      type: 'messages',
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    });
    const top = messagesEl.scrollTop;
    expect(top).toBeGreaterThanOrEqual(3000);
    expect(top).toBeLessThan(3500);
  });
});
