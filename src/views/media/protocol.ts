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

// ── Host → Webview ─────────────────────────────────────────────────

export type HostMessage =
  | { type: 'state'; connected: boolean; baseUrl: string; syncReport: SyncReport | null; sessionId: string | null; model: string | null; sessions: SessionSummary[]; slashCommands: SlashCommandDef[]; maxImageBytes: number; maxImageDimension: number }
  | { type: 'session'; session: SessionSummary }
  | { type: 'messages'; sessionId: string; messages: ChatMessage[] }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'sync'; report: SyncReport }
  | { type: 'stream'; event: StreamEvent }
  | { type: 'stream:ended'; sessionId: string; error?: string }
  | { type: 'info'; text: string }
  | { type: 'error'; message: string }
  | { type: 'model'; model: string | null }
  | { type: 'fileResults'; query: string; files: FileEntry[] };

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
  | { type: 'diag'; level: 'info' | 'error'; message: string };

export type { ApprovalDecision, ChatMessage, MessagePart, SessionSummary, StreamEvent, SyncReport };
