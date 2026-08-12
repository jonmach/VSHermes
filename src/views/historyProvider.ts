/**
 * History tree view — lists Hermes sessions from /api/sessions.
 */

import * as vscode from 'vscode';
import type { SessionSummary } from '../api/types';

/** Friendlier labels for the session source field. */
const SOURCE_LABELS: Record<string, string> = {
  cli: 'terminal',
  api_server: 'vsh-hermes',
  gateway: 'gateway',
};

export class SessionTreeItem extends vscode.TreeItem {
  constructor(readonly session: SessionSummary) {
    super(session.title || session.preview || session.id, vscode.TreeItemCollapsibleState.None);
    this.id = session.id;
    this.tooltip = `${session.id}\n${session.preview ?? ''}`.trim();
    const rel = relativeTime(session.last_active);
    const source = SOURCE_LABELS[session.source ?? ''] ?? session.source ?? '?';
    this.description = `${source} · ${session.model ?? '?'} · ${session.message_count} msgs · ${rel}`;
    this.contextValue = 'session';
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
  }
}

function relativeTime(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export class HistoryProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sessions: SessionSummary[] = [];

  constructor(private readonly loader: () => Promise<SessionSummary[]>) {}

  refresh(sessions?: SessionSummary[]): void {
    if (sessions) {
      this.sessions = sessions;
    } else {
      void this.loader();
      return;
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionTreeItem[] {
    const sorted = [...this.sessions].sort((a, b) => b.last_active - a.last_active);
    return sorted.map((s) => new SessionTreeItem(s));
  }
}
