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
import { HermesApiError, HermesClient } from '../src/api/client';
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

  it('steers a live run mid-stream (0.20.4+ contract)', async () => {
    const created = await client.createSession();
    createdIds.push(created.session.id);

    let runId: string | null = null;
    const steerPromise = new Promise<{ status: number; body: unknown }>((resolve) => {
      const handle = client.sessionChatStream(
        created.session.id,
        'Recursively list every file under /workspace/projects/VSHermes and count them.',
        (ev) => {
          if (ev.type === 'run.started' && ev.run_id && !runId) {
            runId = ev.run_id;
            // Steer the instant the run is live. The run is guaranteed to
            // still be running at this point (it just started), so this
            // must be accepted — unless the model answers before the POST
            // lands (409), which is tolerated rather than flaky.
            client
              .steerRun(ev.run_id, 'Skip the count — just list them.')
              .then((body) => resolve({ status: 200, body }))
              .catch(async (e) => {
                resolve({ status: e.status ?? 0, body: e.message ?? String(e) });
              });
          }
        },
      );
      void handle.done;
    });

    const steer = await steerPromise;
    expect(runId).not.toBeNull();
    if (steer.status === 200) {
      expect(steer.body).toMatchObject({ object: 'hermes.run.steer', accepted: true });
    } else {
      // Race: the run finished before the steer POST landed.
      expect(steer.status).toBe(409);
    }

    const err = await client.steerRun('run_bogus_123', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(HermesApiError);
    expect((err as HermesApiError).status).toBe(404);
    expect((err as HermesApiError).code).toBe('run_not_found');
  }, 180_000);
});
