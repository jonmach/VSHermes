/**
 * Host ↔ webview message protocol. Shared by the extension host (compiled
 * into dist/extension.js) and the webview frontend (bundled into
 * dist/media/chat.js). This module must never import 'vscode'.
 */

import type {
  ApprovalDecision,
  ChatMessage,
  MessagePart,
  SessionSummary,
  StreamEvent,
} from '../../api/types';
import type { SlashCommandDef } from '../../slash/commands';
import type { SyncReport } from '../../api/sync';
import type { EndpointProfile } from '../../endpointCore';

// ── Host → Webview ─────────────────────────────────────────────────

export type HostMessage =
  | { type: 'state'; connected: boolean; baseUrl: string; remote: boolean; syncReport: SyncReport | null; sessionId: string | null; model: string | null; sessions: SessionSummary[]; slashCommands: SlashCommandDef[]; maxImageBytes: number; maxImageDimension: number }
  | { type: 'session'; session: SessionSummary }
  | { type: 'messages'; sessionId: string; messages: ChatMessage[] }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'sync'; report: SyncReport }
  | { type: 'stream'; event: StreamEvent }
  | { type: 'stream:ended'; sessionId: string; error?: string }
  | { type: 'info'; text: string }
  | { type: 'error'; message: string }
  | { type: 'model'; model: string | null }
  | { type: 'fileResults'; query: string; files: FileEntry[] }
  | { type: 'insertTokens'; tokens: string[] }
  | { type: 'browseResult'; path: string | null };

/** A workspace file offered by the @file picker. */
export interface FileEntry {
  /** Path relative to the workspace root (display + filter). */
  rel: string;
  /** Absolute filesystem path (inserted into the message). */
  abs: string;
}

// ── Webview → Host ─────────────────────────────────────────────────

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; parts: MessagePart[]; sessionId?: string }
  | { type: 'newSession' }
  | { type: 'openSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'forkSession' }
  | { type: 'stop' }
  | { type: 'approve'; decision: ApprovalDecision }
  | { type: 'setModel'; model: string }
  | { type: 'chooseModel' }
  | { type: 'skills' }
  | { type: 'setApiKey' }
  | { type: 'listSessions' }
  | { type: 'checkSync' }
  | { type: 'focusHistory' }
  | { type: 'setTitle'; title: string }
  | { type: 'showStatus' }
  | { type: 'fileQuery'; query: string }
  | { type: 'attachDialog' }
  | { type: 'browse' }
  | { type: 'diag'; level: 'info' | 'error'; message: string };

export type { ApprovalDecision, ChatMessage, MessagePart, SessionSummary, StreamEvent, SyncReport };

// ── Endpoints panel (separate webview) ────────────────────────────

export type EndpointsHostMessage =
  | {
      type: 'state';
      endpoints: EndpointProfile[];
      activeId: string | null;
      /** Endpoint ids that have a key stored in SecretStorage. */
      keySet: string[];
      remote: boolean;
      connected: boolean;
      baseUrl: string;
    }
  | { type: 'testResult'; id: string; ok: boolean; detail: string }
  | { type: 'note'; text: string };

export type EndpointsWebviewMessage =
  | { type: 'ready' }
  | { type: 'add'; name: string; url: string }
  | { type: 'update'; id: string; name: string; url: string }
  | { type: 'remove'; id: string }
  | { type: 'setActive'; id: string | null }
  | { type: 'setKey'; id: string; key: string }
  | { type: 'test'; id: string }
  | { type: 'diag'; level: 'info' | 'error'; message: string };
