/**
 * HermesClient — typed HTTP + SSE client for the Hermes API Server.
 *
 * All endpoint paths and response shapes verified against Hermes 0.20.0.
 */

import type {
  ApprovalDecision,
  Capabilities,
  ChatMessage,
  HealthStatus,
  MessagesResponse,
  ModelLockResponse,
  ModelOptionsResponse,
  RunInfo,
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
 */
export async function parseSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: RawSseFrame) => void,
  signal?: AbortSignal,
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
    if (dataLines.length === 0) return;
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
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...extra,
    };
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
      }, controller.signal);
    })();

    return {
      abort: () => controller.abort(),
      done,
    };
  }

  // ── runs ─────────────────────────────────────────────────────────

  createRun(model: string, input: string): Promise<RunInfo> {
    return this.request<RunInfo>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ model, input }),
    });
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
}

/** Convenience: map stored messages to the client-side render shape. */
export function messagesToRender(messages: ChatMessage[]): ChatMessage[] {
  return messages;
}
