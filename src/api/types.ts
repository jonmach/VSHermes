/**
 * VSHermes API types.
 *
 * Every shape here was verified against a live Hermes 0.20.0 API Server
 * (gateway platform api_server, port 8642) before the client was written.
 * See the diagnosis table in the project README.
 */

// ── Health ─────────────────────────────────────────────────────────

export interface HealthStatus {
  status: string;
  platform: string;
  version: string;
  [key: string]: unknown;
}

/** GET /health/detailed — the surface behind /doctor. */
export interface HealthDetailed {
  status: string;
  version: string;
  pid?: number;
  platform?: string;
  gateway_state?: string;
  active_agents?: number;
  readiness?: {
    status: string;
    checks: Record<string, { status: string; used_percent?: number; free_bytes?: number; state?: string; connected_platforms?: number; platforms?: number; [k: string]: unknown }>;
  };
  [key: string]: unknown;
}

// ── Capabilities (GET /v1/capabilities) ────────────────────────────

export interface CapabilityAuth {
  type: string;
  required: boolean;
}

export interface Capabilities {
  object: string;
  platform: string;
  model: string;
  auth: CapabilityAuth;
  runtime: {
    mode: string;
    tool_execution: string;
    split_runtime: boolean;
    description?: string;
  };
  /** Feature key → boolean, or string-valued features (headers, cors…). */
  features: Record<string, boolean | string>;
  /** Endpoint key → { method, path }. */
  endpoints: Record<string, { method: string; path: string }>;
}

// ── Sessions ───────────────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  source: string | null;
  user_id: string | null;
  model: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  api_call_count: number;
  parent_session_id: string | null;
  last_active: number;
  preview: string | null;
}

export interface SessionListResponse {
  object: string;
  data: SessionSummary[];
}

export interface SessionResponse {
  object: string;
  session: SessionSummary & {
    messages?: ChatMessage[];
  };
}

export interface ChatMessage {
  id: number | string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_call_id: string | null;
  tool_calls: unknown[] | null;
  tool_name: string | null;
  timestamp: number;
  token_count: number | null;
  finish_reason: string | null;
  reasoning: string | null;
  reasoning_content: string | null;
}

export interface MessagesResponse {
  object: string;
  session_id: string;
  data: ChatMessage[];
  pagination: { limit: number; offset: number; order: string; returned: number };
}

// ── Chat ───────────────────────────────────────────────────────────

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
}

export type MessagePart = TextPart | ImagePart;

/** Parts (multimodal) or a plain string are both accepted by the API. */
export type UserMessage = string | MessagePart[];

export interface SessionChatRequest {
  message: UserMessage;
}

export interface RuntimeInfo {
  provider: string;
  model: string;
  route_source: string;
  requested?: { provider: string; model: string };
}

export interface SessionChatResponse {
  object: string;
  session_id: string;
  message: { role: string; content: string };
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    runtime: RuntimeInfo;
  };
  runtime: RuntimeInfo;
}

// ── Streaming events (SSE: `event: <type>` / `data: <json>`) ───────
// Event set observed live on POST /api/sessions/{id}/chat/stream.

export interface StreamEventBase {
  session_id: string;
  run_id?: string;
  seq?: number;
  ts?: number;
}

export interface RunStartedEvent extends StreamEventBase {
  type: 'run.started';
  user_message: { role: string; content: unknown };
  runtime: RuntimeInfo;
}

export interface MessageStartedEvent extends StreamEventBase {
  type: 'message.started';
  message: { id: string; role: string };
}

export interface AssistantDeltaEvent extends StreamEventBase {
  type: 'assistant.delta';
  message_id: string;
  delta: string;
}

export interface ToolStartedEvent extends StreamEventBase {
  type: 'tool.started';
  message_id: string;
  tool_name: string;
  preview: string | null;
  args: Record<string, unknown> | null;
}

export interface ToolProgressEvent extends StreamEventBase {
  type: 'tool.progress';
  message_id: string;
  tool_name: string;
  delta: string;
}

export interface ToolCompletedEvent extends StreamEventBase {
  type: 'tool.completed';
  message_id: string;
  tool_name: string;
  preview: string | null;
  args: Record<string, unknown> | null;
}

export interface AssistantCompletedEvent extends StreamEventBase {
  type: 'assistant.completed';
  message_id: string;
  content: string;
  completed: boolean;
  partial: boolean;
  interrupted: boolean;
  runtime: RuntimeInfo;
}

export interface RunCompletedEvent extends StreamEventBase {
  type: 'run.completed';
  message_id: string;
  completed: boolean;
  messages: Array<Record<string, unknown>>;
}

export interface DoneEvent extends StreamEventBase {
  type: 'done';
}

/** Approval requests are advertised (approval_events) but their exact
 * event type name was not observed in this deployment — matched
 * generically by /^approval\./ so any future shape works. No index
 * signature here: it would poison property access on the whole union. */
export interface ApprovalRequestEvent extends StreamEventBase {
  type: `approval.${string}`;
  command?: unknown;
  preview?: unknown;
  tool_name?: unknown;
  args?: unknown;
  decision?: unknown;
  message?: unknown;
}

export type StreamEvent =
  | RunStartedEvent
  | MessageStartedEvent
  | AssistantDeltaEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolCompletedEvent
  | AssistantCompletedEvent
  | RunCompletedEvent
  | DoneEvent
  | ApprovalRequestEvent;

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';

export interface RunInfo {
  run_id: string;
  status: string;
}

/** POST /api/sessions/{id}/model — verified shape: the lock verdict lives
 * inside runtime (there is no top-level model_lock field). */
export interface ModelLockResponse {
  object: string;
  session_id: string;
  runtime: RuntimeInfo & { model_lock: string };
}

// ── Model options ──────────────────────────────────────────────────

export interface ProviderOption {
  slug: string;
  name: string;
  is_current: boolean;
  is_user_defined: boolean;
  models: Array<{ id: string; name?: string }>;
  total_models: number;
  source: string;
  authenticated: boolean;
  auth_type: string | null;
  key_env: string;
  warning: string | null;
  capabilities: Record<string, unknown>;
  featured_models: Array<{ id: string; name?: string }>;
}

export interface ModelOptionsResponse {
  providers: ProviderOption[];
}

// ── Skills / toolsets ──────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  category: string | null;
}

export interface ToolsetInfo {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  tools: string[];
}
