import { describe, expect, it } from 'vitest';
import { parseSse } from '../src/api/client';

/** The raw SSE body captured live from Hermes 0.20.0 (session chat stream). */
const CAPTURED_SSE = `event: run.started
data: {"user_message": {"role": "user", "content": "Reply with exactly: PONG"}, "runtime": {"provider": "", "model": "", "route_source": "global"}, "session_id": "api_test", "run_id": "run_1"}

event: message.started
data: {"message": {"id": "msg_1", "role": "assistant"}, "session_id": "api_test", "run_id": "run_1", "seq": 2, "ts": 1786549745.2}

event: assistant.delta
data: {"message_id": "msg_1", "delta": "P", "session_id": "api_test", "run_id": "run_1", "seq": 3, "ts": 1786549746.8}

event: assistant.delta
data: {"message_id": "msg_1", "delta": "ONG", "session_id": "api_test", "run_id": "run_1", "seq": 4, "ts": 1786549746.8}

event: tool.progress
data: {"message_id": "msg_1", "tool_name": "_thinking", "delta": "PONG", "session_id": "api_test", "run_id": "run_1", "seq": 5, "ts": 1786549746.8}

event: assistant.completed
data: {"session_id": "api_test", "message_id": "msg_1", "content": "PONG", "completed": true, "partial": false, "interrupted": false, "runtime": {"provider": "deepseek", "model": "deepseek-v4-flash"}}

event: run.completed
data: {"session_id": "api_test", "message_id": "msg_1", "completed": true, "messages": [{"role": "assistant", "content": "PONG"}]}

event: done
data: {"session_id": "api_test", "run_id": "run_1", "seq": 8, "ts": 1786549746.8}

`;

function toStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe('parseSse', () => {
  it('parses the live-captured event sequence in order', async () => {
    const frames: Array<{ event: string; data: unknown }> = [];
    await parseSse(toStream(CAPTURED_SSE), (f) => frames.push({ event: f.event, data: JSON.parse(f.data) }));

    expect(frames.map((f) => f.event)).toEqual([
      'run.started',
      'message.started',
      'assistant.delta',
      'assistant.delta',
      'tool.progress',
      'assistant.completed',
      'run.completed',
      'done',
    ]);
    expect((frames[0].data as { run_id: string }).run_id).toBe('run_1');
    expect((frames[5].data as { content: string }).content).toBe('PONG');
    // Reasoning deltas arrive as tool.progress with tool_name _thinking.
    const thinking = frames.find((f) => f.event === 'tool.progress');
    expect((thinking!.data as { tool_name: string }).tool_name).toBe('_thinking');
  });

  it('handles chunked delivery (split mid-frame)', async () => {
    const frames: Array<{ event: string }> = [];
    const encoder = new TextEncoder();
    const bytes = encoder.encode(CAPTURED_SSE);
    const chunks = [bytes.slice(0, 40), bytes.slice(40, 90), bytes.slice(90)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    await parseSse(stream, (f) => frames.push({ event: f.event }));
    expect(frames.length).toBe(8);
  });

  it('handles CRLF line endings', async () => {
    const frames: Array<{ event: string }> = [];
    const crlf = CAPTURED_SSE.replace(/\n/g, '\r\n');
    await parseSse(toStream(crlf), (f) => frames.push({ event: f.event }));
    expect(frames.map((f) => f.event)).toContain('assistant.delta');
  });

  it('skips [DONE] sentinels', async () => {
    const frames: Array<{ event: string; data: string }> = [];
    await parseSse(toStream('event: message\ndata: [DONE]\n\n'), (f) => frames.push(f));
    expect(frames).toEqual([]);
  });
});
