import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HermesApiError, HermesClient } from '../src/api/client';
import { MockHermesServer } from './mockServer';

let server: MockHermesServer;
let client: HermesClient;

beforeAll(async () => {
  server = new MockHermesServer();
  await server.start();
  client = new HermesClient(server.baseUrl, server.apiKey);
});

afterAll(async () => {
  await server.stop();
});

describe('HermesClient (against contract mock)', () => {
  it('fetches health', async () => {
    const h = await client.health();
    expect(h.version).toBe('0.20.0');
  });

  it('fetches capabilities', async () => {
    const c = await client.capabilities();
    expect(c.features.session_chat).toBe(true);
    expect(c.endpoints.session_chat_stream.path).toBe('/api/sessions/{session_id}/chat/stream');
  });

  it('fetches model options with string model IDs (real Hermes shape)', async () => {
    const opts = await client.modelOptions();
    expect(opts.providers.length).toBeGreaterThan(0);
    const prov = opts.providers[0];
    // Real Hermes returns `models` as an array of plain string IDs, not objects.
    expect(Array.isArray(prov.models)).toBe(true);
    expect(prov.models[0]).toBe('deepseek-v4-flash');
  });

  it('lists sessions', async () => {
    const res = await client.listSessions();
    expect(res.data.length).toBe(2);
  });

  it('creates a session', async () => {
    const res = await client.createSession();
    expect(res.session.id).toMatch(/^api_/);
  });

  it('maps duplicate-title error to HermesApiError with code', async () => {
    await client.createSession('Taken title');
    const err = await client.createSession('Taken title').catch((e) => e);
    expect(err).toBeInstanceOf(HermesApiError);
    expect((err as HermesApiError).status).toBe(400);
    expect((err as HermesApiError).code).toBe('invalid_title');
    expect((err as HermesApiError).message).toContain('Title already in use');
  });

  it('gets, patches and deletes a session', async () => {
    const created = await client.createSession();
    const id = created.session.id;
    const got = await client.getSession(id);
    expect(got.session.id).toBe(id);
    await client.patchSession(id, { title: 'renamed' });
    const after = await client.getSession(id);
    expect(after.session.title).toBe('renamed');
    await client.deleteSession(id);
    const err = await client.getSession(id).catch((e) => e);
    expect((err as HermesApiError).status).toBe(404);
  });

  it('forks a session (auto-suffixed title)', async () => {
    const created = await client.createSession('Forkable');
    const fork = await client.forkSession(created.session.id);
    expect(fork.session.id).not.toBe(created.session.id);
    expect(fork.session.title).toBe('Forkable #2');
  });

  it('locks a model on a session', async () => {
    const created = await client.createSession();
    const res = await client.lockModel(created.session.id, 'gpt-x');
    expect(res.runtime.model_lock).toBe('accepted');
  });

  it('sends a non-streaming chat', async () => {
    const created = await client.createSession();
    const res = await client.sessionChat(created.session.id, 'Reply with exactly: PONG');
    expect(res.message.content).toBe('PONG');
    expect(res.usage.total_tokens).toBeGreaterThan(0);
  });

  it('streams chat and receives the full event sequence', async () => {
    const created = await client.createSession();
    const events: string[] = [];
    const handle = client.sessionChatStream(created.session.id, 'Reply with exactly: PONG', (ev) => events.push(ev.type));
    await handle.done;
    expect(events).toEqual([
      'run.started',
      'message.started',
      'assistant.delta',
      'assistant.delta',
      'tool.started',
      'tool.progress',
      'tool.completed',
      'assistant.completed',
      'run.completed',
      'done',
    ]);
  });

  it('stream aborts on request', async () => {
    const created = await client.createSession();
    let done = false;
    const handle = client.sessionChatStream(created.session.id, 'x', () => undefined);
    handle.done.then(() => (done = true));
    handle.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(true);
  });

  it('creates and stops a run', async () => {
    const run = await client.createRun('hermes-agent', 'PONG');
    expect(run.run_id).toMatch(/^run_/);
    const stopped = await client.stopRun(run.run_id);
    expect(stopped).toEqual({ ok: true });
  });

  it('resolves an approval', async () => {
    const run = await client.createRun('hermes-agent', 'PONG');
    const res = await client.approveRun(run.run_id, 'once');
    expect(res).toEqual({ ok: true });
  });

  it('throws a friendly connection error when unreachable', async () => {
    const c = new HermesClient('http://127.0.0.1:1', 'x');
    const err = await c.health().catch((e) => e);
    expect(err).toBeInstanceOf(HermesApiError);
    expect((err as HermesApiError).code).toBe('connection_failed');
    expect((err as HermesApiError).message).toContain('gateway running');
  });

  it('rejects unauthenticated requests with 401 mapping', async () => {
    const bad = new HermesClient(server.baseUrl, 'wrong-key');
    const err = await bad.listSessions().catch((e) => e);
    expect(err).toBeInstanceOf(HermesApiError);
    expect((err as HermesApiError).status).toBe(401);
  });

  it('fetches skills and toolsets', async () => {
    const skills = await client.listSkills();
    expect(skills.data.length).toBeGreaterThan(0);
    const ts = await client.listToolsets();
    expect(ts.data[0].name).toBe('web');
  });
});
