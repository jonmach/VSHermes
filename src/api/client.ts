/**
 * HermesClient — typed HTTP + SSE client for the Hermes API Server.
 *
 * All endpoint paths and response shapes verified against Hermes 0.20.0.
 */

import type {
  ApprovalDecision,
  Capabilities,
  ChatMessage,
  HealthDetailed,
  HealthStatus,
  MessagePart,
  MessagesResponse,
  ModelLockResponse,
  ModelOptionsResponse,
  RunInfo,
  RuntimeInfo,
  SessionChatRequest,
  SessionChatResponse,
  SessionListResponse,
  SessionResponse,
  SkillInfo,
  StreamEvent,
  ToolsetInfo,
  UserMessage,
} from './types';

export class HermesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly type?: string,
  ) {
    super(message);
    this.name = 'HermesApiError';
  }
}

export interface StreamHandle {
  /** Abort the underlying request (used by Stop). */
  abort(): void;
  /** Resolves when the stream ends (or fails). */
  done: Promise<void>;
}

interface RawSseFrame {
  event: string;
  data: string;
}

/**
 * Parse an SSE byte stream from a ReadableStream<Uint8Array>.
 * Emits { event, data } frames for each blank-line-delimited block.
 * Handles CRLF, multi-line `data:` continuation, and `data: [DONE]`.
 *
 * Comment-only blocks (e.g. the gateway's `: keepalive` lines) carry no
 * event or data — they are not emitted as frames, but `onKeepalive` (when
 * provided) fires so the caller can distinguish "connection alive, server
 * grinding" from "connection dead" (no bytes at all).
 */
export async function parseSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: RawSseFrame) => void,
  signal?: AbortSignal,
  onKeepalive?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushBlock = (block: string) => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      // Comment-only frame (`: keepalive`) — the connection is alive but
      // no event arrived. Not a frame; report the liveness signal.
      if (onKeepalive && block.trim().length > 0) onKeepalive();
      return;
    }
    const data = dataLines.join('\n');
    if (data === '[DONE]') return;
    onFrame({ event, data });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Block separator is \n\n (LF) or \r\n\r\n (CRLF) — take the earliest.
    let idx: number;
    for (;;) {
      const sepLf = buffer.indexOf('\n\n');
      const sepCrlf = buffer.indexOf('\r\n\r\n');
      if (sepLf === -1 && sepCrlf === -1) break;
      idx = sepLf === -1 ? sepCrlf : sepCrlf === -1 ? sepLf : Math.min(sepLf, sepCrlf);
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      flushBlock(block.replace(/\r$/, ''));
    }
  }
  if (buffer.trim().length > 0) {
    flushBlock(buffer);
  }
}

export class HermesClient {
  readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  // ── plumbing ─────────────────────────────────────────────────────

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    // Keyless clients (loopback with no resolved key) send no Authorization
    // header at all — an empty `Bearer ` token is not the same as no key.
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init?.headers as Record<string, string> | undefined),
      });
    } catch (err) {
      throw new HermesApiError(
        `Cannot reach Hermes at ${this.baseUrl} (${(err as Error).message}). Is the gateway running?`,
        0,
        'connection_failed',
      );
    }
    if (!res.ok) {
      const detail = await this.readErrorBody(res);
      throw new HermesApiError(
        detail.message || `${res.status} ${res.statusText}`,
        res.status,
        detail.code,
        detail.type,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async readErrorBody(res: Response): Promise<{ message?: string; code?: string; type?: string }> {
    try {
      const body = (await res.json()) as {
        error?: { message?: string; code?: string; type?: string };
      };
      return body.error ?? {};
    } catch {
      return {};
    }
  }

  // ── health & capabilities ────────────────────────────────────────

  health(): Promise<HealthStatus> {
    return this.request<HealthStatus>('/health', { method: 'GET' });
  }

  capabilities(): Promise<Capabilities> {
    return this.request<Capabilities>('/v1/capabilities', { method: 'GET' });
  }

  // ── sessions ─────────────────────────────────────────────────────

  listSessions(limit = 100): Promise<SessionListResponse> {
    return this.request<SessionListResponse>(
      `/api/sessions?limit=${limit}&order=latest`,
      { method: 'GET' },
    );
  }

  /** Titles are unique per API server — omit it and let Hermes derive one. */
  createSession(title?: string): Promise<SessionResponse> {
    return this.request<SessionResponse>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    });
  }

  getSession(id: string): Promise<SessionResponse> {
    return this.request<SessionResponse>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  patchSession(id: string, patch: { title?: string }): Promise<SessionResponse> {
    return this.request<SessionResponse>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  deleteSession(id: string): Promise<void> {
    return this.request<void>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  sessionMessages(id: string, limit = 500): Promise<MessagesResponse> {
    return this.request<MessagesResponse>(
      `/api/sessions/${encodeURIComponent(id)}/messages?limit=${limit}`,
      { method: 'GET' },
    );
  }

  forkSession(id: string): Promise<SessionResponse> {
    return this.request<SessionResponse>(`/api/sessions/${encodeURIComponent(id)}/fork`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  lockModel(sessionId: string, model: string): Promise<ModelLockResponse> {
    return this.request<ModelLockResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/model`,
      { method: 'POST', body: JSON.stringify({ model }) },
    );
  }

  // ── chat ─────────────────────────────────────────────────────────

  async sessionChat(sessionId: string, message: UserMessage): Promise<SessionChatResponse> {
    const body: SessionChatRequest = { message };
    return this.request<SessionChatResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/chat`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  /**
   * Streaming chat. Parses the SSE stream and dispatches typed events.
   * Returns a handle with abort() + done (for the Stop button).
   */
  sessionChatStream(
    sessionId: string,
    message: UserMessage,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
    onKeepalive?: () => void,
  ): StreamHandle {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const body: SessionChatRequest = { message };
    const done = (async () => {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        throw new HermesApiError(
          `Cannot reach Hermes at ${this.baseUrl} (${(err as Error).message})`,
          0,
          'connection_failed',
        );
      }
      if (!res.ok || !res.body) {
        const detail = await this.readErrorBody(res);
        throw new HermesApiError(
          detail.message || `${res.status} ${res.statusText}`,
          res.status,
          detail.code,
          detail.type,
        );
      }
      await parseSse(res.body, (frame) => {
        try {
          const parsed = JSON.parse(frame.data) as StreamEvent;
          onEvent({ ...parsed, type: frame.event } as StreamEvent);
        } catch {
          // Non-JSON data frames are ignored.
        }
      }, controller.signal, onKeepalive);
    })();

    return {
      abort: () => controller.abort(),
      done,
    };
  }

  // ── runs ─────────────────────────────────────────────────────────

  createRun(model: string | undefined, input: UserMessage, sessionId?: string): Promise<RunInfo> {
    // The runs API needs the model explicitly (it does NOT fall back to the
    // session's locked model) and persists the turn into `session_id`'s
    // transcript — both verified live against 0.20.5. `input` accepts a
    // plain string OR an OpenAI-style message array whose last item carries
    // `content` — VSHermes parts are content blocks, so wrap them in a user
    // message (a bare parts array 400s with "No user message found in input").
    const body: Record<string, unknown> = {};
    body.input =
      typeof input === 'string'
        ? input
        : [{ role: 'user', content: input as MessagePart[] }];
    if (model) body.model = model;
    if (sessionId) body.session_id = sessionId;
    return this.request<RunInfo>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Runs-based streaming chat — the approval-capable surface on stock Hermes.
   *
   * POST /v1/runs (input + model + session_id) → run_id, then GET
   * /v1/runs/{run_id}/events (SSE). Unlike the session-chat stream, the runs
   * stream embeds the event type INSIDE each JSON frame ({"event":
   * "message.delta", ...}) — there is no `event:` SSE line — and ends after
   * `run.completed` with NO `done` frame (verified live 0.20.5). Events are
   * normalized to the same StreamEvent vocabulary the webview already
   * consumes, including a synthesized run.started / message.started /
   * assistant.completed / done.
   */
  runChatStream(
    sessionId: string,
    model: string | undefined,
    message: UserMessage,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
    onKeepalive?: () => void,
  ): StreamHandle {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const done = (async () => {
      let run: RunInfo;
      try {
        run = await this.createRun(model, message, sessionId);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        throw err;
      }
      const runId = run.run_id;
      const messageId = `msg_${runId.replace(/^run_/, '')}`;
      const base = { run_id: runId, session_id: sessionId };
      const synth = (type: string, extra: Record<string, unknown> = {}): StreamEvent =>
        ({ ...base, ...extra, type } as StreamEvent);

      // The POST response IS the start signal — the runs stream has no
      // run.started and no message.started.
      onEvent(synth('run.started', {
        user_message: { role: 'user', content: message },
        runtime: { provider: '', model: '', route_source: '' },
      }));
      onEvent(synth('message.started', { message: { id: messageId, role: 'assistant' } }));

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
          method: 'GET',
          headers: this.headers(),
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        throw new HermesApiError(
          `Cannot reach Hermes at ${this.baseUrl} (${(err as Error).message})`,
          0,
          'connection_failed',
        );
      }
      if (!res.ok || !res.body) {
        const detail = await this.readErrorBody(res);
        throw new HermesApiError(
          detail.message || `${res.status} ${res.statusText}`,
          res.status,
          detail.code,
          detail.type,
        );
      }
      await parseSse(res.body, (frame) => {
        try {
          const parsed = JSON.parse(frame.data) as { event?: string } & Record<string, unknown>;
          const type = parsed.event;
          if (!type) return;
          switch (type) {
            case 'message.delta':
              onEvent(synth('assistant.delta', { message_id: messageId, delta: String(parsed.delta ?? '') }));
              break;
            case 'tool.started':
              onEvent(synth('tool.started', {
                message_id: messageId,
                tool_name: String(parsed.tool ?? ''),
                preview: (parsed.preview as string | null) ?? null,
                args: null,
              }));
              break;
            case 'tool.completed':
              onEvent(synth('tool.completed', {
                message_id: messageId,
                tool_name: String(parsed.tool ?? ''),
                preview: null,
                args: null,
              }));
              // The runs stream flags failures on tool.completed itself
              // (error: true) — the webview needs tool.failed to flip the card.
              if (parsed.error) {
                onEvent(synth('tool.failed', {
                  message_id: messageId,
                  tool_name: String(parsed.tool ?? ''),
                  preview: null,
                  args: null,
                }));
              }
              break;
            case 'reasoning.available':
              onEvent(synth('tool.progress', {
                message_id: messageId,
                tool_name: '_thinking',
                delta: String(parsed.text ?? ''),
              }));
              break;
            case 'approval.request':
              onEvent(synth('approval.request', {
                command: parsed.command,
                preview: parsed.preview,
                pattern_key: parsed.pattern_key,
                pattern_keys: parsed.pattern_keys,
                description: parsed.description,
                allow_permanent: parsed.allow_permanent,
                allow_session: parsed.allow_session,
                request_id: parsed.request_id,
                choices: parsed.choices,
              }));
              break;
            case 'approval.responded':
              onEvent(synth('approval.responded', { choice: parsed.choice, resolved: parsed.resolved }));
              break;
            case 'run.completed':
              onEvent(synth('assistant.completed', {
                message_id: messageId,
                content: String(parsed.output ?? ''),
                completed: true,
                partial: false,
                interrupted: false,
                runtime: ((parsed.usage as { runtime?: RuntimeInfo } | undefined)?.runtime ?? {}) as RuntimeInfo,
              }));
              onEvent(synth('run.completed', {
                message_id: messageId,
                completed: true,
                messages: [],
                usage: parsed.usage,
              }));
              onEvent(synth('done'));
              break;
            case 'run.failed':
              onEvent(synth('run.failed', { error: String(parsed.error ?? 'unknown error') }));
              break;
            case 'run.cancelled':
              onEvent(synth('run.cancelled'));
              break;
            case 'error':
              onEvent(synth('error', { message: String(parsed.message ?? 'unknown error') }));
              break;
            default:
              // Unknown frames are ignored — forward compatibility.
              break;
          }
        } catch {
          // Non-JSON data frames are ignored.
        }
      }, controller.signal, onKeepalive);
    })();

    return {
      abort: () => controller.abort(),
      done,
    };
  }

  getRun(runId: string): Promise<RunInfo> {
    return this.request<RunInfo>(`/v1/runs/${encodeURIComponent(runId)}`, {
      method: 'GET',
    });
  }

  stopRun(runId: string): Promise<unknown> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  /** POST /v1/runs/{runId}/steer — inject guidance into a running agent (0.20.4+). */
  steerRun(runId: string, input: string): Promise<unknown> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
  }

  approveRun(runId: string, decision: ApprovalDecision): Promise<unknown> {
    // The API server reads the `choice` field (values: once/session/always/
    // deny) — sending `decision` made every approval fail with 400
    // "Invalid approval choice".
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST',
      body: JSON.stringify({ choice: decision }),
    });
  }

  // ── discovery ────────────────────────────────────────────────────

  modelOptions(): Promise<ModelOptionsResponse> {
    return this.request<ModelOptionsResponse>('/api/model/options', { method: 'GET' });
  }

  listSkills(): Promise<{ data: SkillInfo[] }> {
    return this.request<{ data: SkillInfo[] }>('/v1/skills', { method: 'GET' });
  }

  listToolsets(): Promise<{ data: ToolsetInfo[] }> {
    return this.request<{ data: ToolsetInfo[] }>('/v1/toolsets', { method: 'GET' });
  }

  /** Detailed server diagnostics (readiness checks, gateway state, disk). */
  healthDetailed(): Promise<HealthDetailed> {
    return this.request<HealthDetailed>('/health/detailed', { method: 'GET' });
  }
}

/** Convenience: map stored messages to the client-side render shape. */
export function messagesToRender(messages: ChatMessage[]): ChatMessage[] {
  return messages;
}
