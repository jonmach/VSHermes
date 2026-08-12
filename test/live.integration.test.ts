/**
 * Live integration test against a REAL Hermes API Server.
 *
 * Skipped unless VSHERMES_LIVE=1 and a base URL + key are available.
 *   VSHERMES_LIVE=1 VSHERMES_BASE_URL=http://127.0.0.1:8642 VSHERMES_API_KEY=... npm run test:live
 *
 * The key can also be read from $HERMES_HOME/.env or ~/.hermes/.env
 * (API_SERVER_KEY) when not passed explicitly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HermesClient } from '../src/api/client';
import type { StreamEvent } from '../src/api/types';

function loadKeyFromEnvFile(): string | undefined {
  const candidates = [
    process.env.HERMES_HOME ? join(process.env.HERMES_HOME, '.env') : null,
    join(homedir(), '.hermes', '.env'),
  ].filter((p): p is string => !!p && existsSync(p));
  for (const p of candidates) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^API_SERVER_KEY=(.+)$/.exec(line.trim());
      if (m) return m[1];
    }
  }
  return undefined;
}

const live = process.env.VSHERMES_LIVE === '1';
const baseUrl = process.env.VSHERMES_BASE_URL ?? 'http://127.0.0.1:8642';
const apiKey = process.env.VSHERMES_API_KEY ?? loadKeyFromEnvFile() ?? '';

describe.skipIf(!live)('live Hermes API Server', () => {
  const client = new HermesClient(baseUrl, apiKey);
  const createdIds: string[] = [];

  afterAll(async () => {
    for (const id of createdIds) {
      await client.deleteSession(id).catch(() => undefined);
    }
  });

  it('health + capabilities round trip', async () => {
    const h = await client.health();
    expect(h.status).toBe('ok');
    const c = await client.capabilities();
    expect(c.features.session_chat_streaming).toBe(true);
  });

  it('full session lifecycle: create → stream chat → messages → fork → delete', async () => {
    const created = await client.createSession();
    createdIds.push(created.session.id);
    expect(created.session.id).toMatch(/^api_/);

    // streaming chat against the real gateway
    const events: string[] = [];
    let sawThinking = false;
    const handle = client.sessionChatStream(created.session.id, 'Reply with exactly: PONG', (ev: StreamEvent) => {
      events.push(ev.type);
      if (ev.type === 'tool.progress' && ev.tool_name === '_thinking') sawThinking = true;
    });
    await handle.done;
    expect(events[0]).toBe('run.started');
    expect(events).toContain('assistant.delta');
    expect(events[events.length - 1]).toBe('done');

    const msgs = await client.sessionMessages(created.session.id);
    expect(msgs.data.length).toBeGreaterThanOrEqual(2);
    expect(msgs.data[msgs.data.length - 1].role).toBe('assistant');
    expect(msgs.data[msgs.data.length - 1].content).toContain('PONG');

    const fork = await client.forkSession(created.session.id);
    createdIds.push(fork.session.id);
    expect(fork.session.message_count).toBeGreaterThanOrEqual(2);
  }, 180_000);

  it('multimodal image parts are accepted and routed', async () => {
    // 1x1 transparent PNG (valid bytes).
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const created = await client.createSession();
    createdIds.push(created.session.id);
    const res = await client.sessionChat(created.session.id, [
      { type: 'text', text: 'Describe the image in one word.' },
      { type: 'image_url', image_url: { url: png } },
    ]);
    expect(res.message.content.length).toBeGreaterThan(0);
  }, 180_000);

  it('model lock round trip', async () => {
    const created = await client.createSession();
    createdIds.push(created.session.id);
    const res = await client.lockModel(created.session.id, 'deepseek-v4-flash');
    expect(res.runtime.model_lock).toBe('accepted');
  });

  it('runs API: create + status', async () => {
    const run = await client.createRun('hermes-agent', 'Reply with exactly: PONG');
    expect(run.run_id).toMatch(/^run_/);
    const status = await client.getRun(run.run_id);
    expect(status.run_id).toBe(run.run_id);
  }, 180_000);
});
