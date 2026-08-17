/**
 * Mock Hermes API Server — implements the contract verified against the
 * live Hermes 0.20.0 gateway (see README diagnosis table) so the client
 * and sync engine can be tested without a running gateway.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const API_KEY = 'test-key-123456';

interface MockSession {
  id: string;
  title: string | null;
  model: string;
  message_count: number;
  last_active: number;
  started_at: number;
  messages: unknown[];
}

export const MOCK_CAPABILITIES = {
  object: 'hermes.api_server.capabilities',
  platform: 'hermes-agent',
  model: 'hermes-agent',
  auth: { type: 'bearer', required: true },
  runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
  features: {
    chat_completions: true,
    chat_completions_streaming: true,
    responses_api: true,
    responses_streaming: true,
    run_submission: true,
    run_status: true,
    run_events_sse: true,
    run_stop: true,
    run_approval_response: true,
    tool_progress_events: true,
    approval_events: true,
    session_resources: true,
    model_options: true,
    session_chat: true,
    session_chat_streaming: true,
    session_fork: true,
    session_model_lock: true,
    admin_config_rw: false,
    jobs_admin: false,
    memory_write_api: false,
    skills_api: true,
    audio_api: false,
    realtime_voice: false,
    session_continuity_header: 'X-Hermes-Session-Id',
    session_key_header: 'X-Hermes-Session-Key',
    cors: false,
  },
  endpoints: {
    health: { method: 'GET', path: '/health' },
    models: { method: 'GET', path: '/v1/models' },
    model_options: { method: 'GET', path: '/api/model/options' },
    chat_completions: { method: 'POST', path: '/v1/chat/completions' },
    runs: { method: 'POST', path: '/v1/runs' },
    run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
    run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
    run_approval: { method: 'POST', path: '/v1/runs/{run_id}/approval' },
    run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
    skills: { method: 'GET', path: '/v1/skills' },
    toolsets: { method: 'GET', path: '/v1/toolsets' },
    sessions: { method: 'GET', path: '/api/sessions' },
    session_create: { method: 'POST', path: '/api/sessions' },
    session: { method: 'GET', path: '/api/sessions/{session_id}' },
    session_update: { method: 'PATCH', path: '/api/sessions/{session_id}' },
    session_delete: { method: 'DELETE', path: '/api/sessions/{session_id}' },
    session_messages: { method: 'GET', path: '/api/sessions/{session_id}/messages' },
    session_fork: { method: 'POST', path: '/api/sessions/{session_id}/fork' },
    session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' },
    session_chat_stream: { method: 'POST', path: '/api/sessions/{session_id}/chat/stream' },
    session_model_lock: { method: 'POST', path: '/api/sessions/{session_id}/model' },
  },
};

/** The exact event sequence captured live from the 0.20.0 gateway
 * (truncated to the interesting frames). */
export const CAPTURED_STREAM = [
  ['run.started', { user_message: { role: 'user', content: 'Reply with exactly: PONG' }, runtime: { provider: '', model: '', route_source: 'global' }, session_id: 'api_test_1', run_id: 'run_test_1' }],
  ['message.started', { message: { id: 'msg_1', role: 'assistant' }, session_id: 'api_test_1', run_id: 'run_test_1', seq: 2 }],
  ['assistant.delta', { message_id: 'msg_1', delta: 'P', session_id: 'api_test_1', run_id: 'run_test_1', seq: 3 }],
  ['assistant.delta', { message_id: 'msg_1', delta: 'ONG', session_id: 'api_test_1', run_id: 'run_test_1', seq: 4 }],
  ['tool.started', { message_id: 'msg_1', tool_name: 'terminal', preview: 'echo hi', args: { command: 'echo hi' }, session_id: 'api_test_1', run_id: 'run_test_1', seq: 5 }],
  ['tool.progress', { message_id: 'msg_1', tool_name: '_thinking', delta: 'The user wants a ping.', session_id: 'api_test_1', run_id: 'run_test_1', seq: 6 }],
  ['tool.completed', { message_id: 'msg_1', tool_name: 'terminal', preview: null, args: null, session_id: 'api_test_1', run_id: 'run_test_1', seq: 7 }],
  ['assistant.completed', { session_id: 'api_test_1', message_id: 'msg_1', content: 'PONG', completed: true, partial: false, interrupted: false, runtime: { provider: 'deepseek', model: 'deepseek-v4-flash' } }],
  ['run.completed', { session_id: 'api_test_1', message_id: 'msg_1', completed: true, messages: [{ role: 'assistant', content: 'PONG' }] }],
  ['done', { session_id: 'api_test_1', run_id: 'run_test_1', seq: 8 }],
] as const;

export class MockHermesServer {
  private server: Server;
  private sessions: MockSession[] = [];
  baseUrl = '';
  readonly apiKey = API_KEY;

  constructor() {
    const now = Date.now() / 1000;
    this.sessions = [
      {
        id: 'api_seed_1',
        title: 'Seed session one',
        model: 'deepseek-v4-flash',
        message_count: 3,
        last_active: now - 120,
        started_at: now - 3600,
        messages: [],
      },
      {
        id: 'api_seed_2',
        title: 'Seed session two',
        model: 'deepseek-v4-flash',
        message_count: 1,
        last_active: now - 30,
        started_at: now - 7200,
        messages: [],
      },
    ];

    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  private json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
    const raw = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) });
    res.end(raw);
  }

  private authOk(req: import('node:http').IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${API_KEY}`;
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!this.authOk(req) && path !== '/health') {
      this.json(res, 401, { error: { message: 'Unauthorized', code: 'unauthorized' } });
      return;
    }

    if (method === 'GET' && path === '/health') {
      this.json(res, 200, { status: 'ok', platform: 'hermes-agent', version: '0.20.0' });
      return;
    }
    if (method === 'GET' && path === '/v1/capabilities') {
      this.json(res, 200, MOCK_CAPABILITIES);
      return;
    }
    if (method === 'GET' && path === '/v1/models') {
      this.json(res, 200, { object: 'list', data: [{ id: 'hermes-agent', object: 'model' }] });
      return;
    }
    if (method === 'GET' && path === '/v1/skills') {
      this.json(res, 200, { object: 'list', data: [{ name: 'hermes-model-fallbacks', description: 'Fallback chains', category: null }] });
      return;
    }
    if (method === 'GET' && path === '/v1/toolsets') {
      this.json(res, 200, { object: 'list', platform: 'api_server', data: [{ name: 'web', label: 'Web', description: 'x', enabled: true, configured: true, tools: ['web_search'] }] });
      return;
    }
    if (method === 'GET' && path === '/api/model/options') {
      // Mirror real Hermes: `models` is an array of plain string IDs (see
      // hermes_cli/inventory.py `build_models_payload`). The object form is
      // kept as a regression guard for older/tolerant clients.
      this.json(res, 200, { providers: [{ slug: 'deepseek', name: 'DeepSeek', is_current: true, models: ['deepseek-v4-flash'], total_models: 1, authenticated: true, auth_type: 'api_key', key_env: 'DEEPSEEK_API_KEY', warning: null, featured_models: ['deepseek-v4-flash'] }] });
      return;
    }

    // sessions collection
    if (path === '/api/sessions' && method === 'GET') {
      const data = this.sessions.map((s) => ({ ...s, preview: null, source: 'api_server', user_id: null, ended_at: null, end_reason: null, tool_call_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, estimated_cost_usd: null, actual_cost_usd: null, api_call_count: 0, parent_session_id: null }));
      this.json(res, 200, { object: 'list', data });
      return;
    }
    if (path === '/api/sessions' && method === 'POST') {
      const body = await readBody(req);
      const title = body.title as string | undefined;
      if (title && this.sessions.some((s) => s.title === title)) {
        const existing = this.sessions.find((s) => s.title === title)!;
        this.json(res, 400, { error: { message: `Title already in use by session ${existing.id}`, type: 'invalid_request_error', code: 'invalid_title' } });
        return;
      }
      const now = Date.now() / 1000;
      const session: MockSession = {
        id: `api_${Date.now()}`,
        title: title ?? null,
        model: 'hermes-agent',
        message_count: 0,
        last_active: now,
        started_at: now,
        messages: [],
      };
      this.sessions.unshift(session);
      this.json(res, 201, { object: 'hermes.session', session });
      return;
    }

    // session-scoped
    const m = path.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    if (m) {
      const sid = m[1];
      const rest = m[2] ?? '';
      const session = this.sessions.find((s) => s.id === sid);
      if (!session) {
        this.json(res, 404, { error: { message: `Session not found: ${sid}`, code: 'not_found' } });
        return;
      }
      if (rest === '' && method === 'GET') {
        this.json(res, 200, { object: 'hermes.session', session });
        return;
      }
      if (rest === '' && method === 'PATCH') {
        const body = await readBody(req);
        if (typeof body.title === 'string') session.title = body.title;
        this.json(res, 200, { object: 'hermes.session', session });
        return;
      }
      if (rest === '' && method === 'DELETE') {
        this.sessions = this.sessions.filter((s) => s.id !== sid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (rest === '/messages' && method === 'GET') {
        this.json(res, 200, { object: 'list', session_id: sid, data: session.messages, pagination: { limit: 500, offset: 0, order: 'latest', returned: session.messages.length } });
        return;
      }
      if (rest === '/chat' && method === 'POST') {
        const body = await readBody(req);
        session.messages.push({ id: 1, session_id: sid, role: 'user', content: typeof body.message === 'string' ? body.message : JSON.stringify(body.message), timestamp: Date.now() / 1000 });
        session.messages.push({ id: 2, session_id: sid, role: 'assistant', content: 'PONG', finish_reason: 'stop', timestamp: Date.now() / 1000 });
        session.message_count += 2;
        session.last_active = Date.now() / 1000;
        this.json(res, 200, {
          object: 'hermes.session.chat.completion',
          session_id: sid,
          message: { role: 'assistant', content: 'PONG' },
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, runtime: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
          runtime: { provider: 'deepseek', model: 'deepseek-v4-flash' },
        });
        return;
      }
      if (rest === '/chat/stream' && method === 'POST') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        for (const [event, data] of CAPTURED_STREAM) {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify({ ...data, session_id: sid })}\n\n`);
        }
        res.end();
        return;
      }
      if (rest === '/model' && method === 'POST') {
        const body = await readBody(req);
        this.json(res, 200, { object: 'hermes.session.model_lock', session_id: sid, runtime: { provider: '', model: body.model, route_source: 'raw_request', requested: { provider: '', model: body.model }, model_lock: 'accepted' } });
        return;
      }
      if (rest === '/fork' && method === 'POST') {
        const now = Date.now() / 1000;
        const fork: MockSession = { ...session, id: `api_${Date.now()}`, title: session.title ? `${session.title} #2` : null, started_at: now, last_active: now, messages: [...session.messages] };
        this.sessions.unshift(fork);
        this.json(res, 201, { object: 'hermes.session', session: fork });
        return;
      }
    }

    if (path === '/v1/runs' && method === 'POST') {
      this.json(res, 202, { run_id: 'run_test_created', status: 'started' });
      return;
    }
    const runM = path.match(/^\/v1\/runs\/([^/]+)\/(stop|approval)$/);
    if (runM && method === 'POST') {
      this.json(res, 200, { ok: true });
      return;
    }

    this.json(res, 404, { error: { message: `Not found: ${method} ${path}`, code: 'not_found' } });
  }
}

function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
