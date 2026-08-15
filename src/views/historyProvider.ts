/**
 * History tree view — Hermes sessions grouped by endpoint (server).
 *
 * The tree renders one collapsible section per endpoint that has cached
 * sessions ("Local", profile names), so sessions from every server the
 * extension has talked to stay visible and reopenable. Opening a session
 * under another server auto-switches the active endpoint first (the host
 * handles that via the { ep, sid } command argument).
 */

import * as vscode from 'vscode';
import type { SessionSummary } from '../api/types';
import { filterSessions } from '../sessionFilter';
import { sessionTooltip, sessionUsage } from '../sessionFormat';

/** Friendlier labels for the session source field. */
const SOURCE_LABELS: Record<string, string> = {
  cli: 'terminal',
  api_server: 'vsh-hermes',
  gateway: 'gateway',
};

export type HistoryTreeItem = SessionSectionItem | SessionTreeItem;

export class SessionSectionItem extends vscode.TreeItem {
  constructor(
    /** Canonical server URL — the session-cache key. */
    readonly serverKey: string,
    label: string,
    remote: boolean,
    count: number,
  ) {
    super(`${label}${remote ? ' — remote' : ''} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `section:${serverKey}`;
    this.description = remote ? 'attach disabled' : 'attach enabled';
    this.contextValue = 'section';
    this.iconPath = new vscode.ThemeIcon('server');
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    /** Resolved endpoint id the session lives on (for auto-switch). */
    readonly endpointId: string,
    readonly session: SessionSummary,
  ) {
    super(session.title || session.preview || session.id, vscode.TreeItemCollapsibleState.None);
    this.id = `${endpointId}:${session.id}`;
    this.tooltip = sessionTooltip(session);
    const rel = relativeTime(session.last_active);
    const source = SOURCE_LABELS[session.source ?? ''] ?? session.source ?? '?';
    const usage = sessionUsage(session);
    const lineage = session.end_reason === 'compression' ? ' · compressed' : '';
    this.description = `${source} · ${session.model ?? '?'} · ${session.message_count} msgs${usage} · ${rel}${lineage}`;
    this.contextValue = 'session';
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    // Row click opens the session — argument carries the owning endpoint so
    // the host can auto-switch servers before loading it.
    this.command = {
      command: 'vsh.hermes.openSession',
      title: 'Open Session',
      arguments: [{ ep: endpointId, sid: session.id }],
    };
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

export interface HistoryContext {
  /** Display label for a canonical server URL. */
  endpointLabel(url: string): string;
  /** True when the server URL is a non-loopback (remote) host. */
  endpointRemote(url: string): boolean;
  /** Resolve a server URL to the endpoint id to switch to on open. */
  endpointIdForUrl(url: string): string;
}

export class HistoryProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cache: Record<string, SessionSummary[]> = {};
  private filterText = '';

  constructor(private readonly ctx: HistoryContext) {}

  get filterActive(): boolean {
    return this.filterText !== '';
  }

  get filter(): string {
    return this.filterText;
  }

  setFilter(filter: string): void {
    this.filterText = filter.trim();
    this._onDidChangeTreeData.fire();
  }

  refresh(cache: Record<string, SessionSummary[]>): void {
    this.cache = cache;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: HistoryTreeItem): HistoryTreeItem[] {
    if (!element) {
      return this.sections();
    }
    if (element instanceof SessionSectionItem) {
      const sessions = this.filtered(element.serverKey);
      const ep = this.ctx.endpointIdForUrl(element.serverKey);
      return [...sessions].sort((a, b) => b.last_active - a.last_active).map((s) => new SessionTreeItem(ep, s));
    }
    return [];
  }

  private sections(): SessionSectionItem[] {
    const out: SessionSectionItem[] = [];
    for (const [url, sessions] of Object.entries(this.cache)) {
      const filtered = filterSessions(sessions, this.filterText);
      if (filtered.length === 0) continue;
      out.push(new SessionSectionItem(url, this.ctx.endpointLabel(url), this.ctx.endpointRemote(url), filtered.length));
    }
    out.sort((a, b) => {
      const newestA = this.newestActive(a.serverKey);
      const newestB = this.newestActive(b.serverKey);
      return newestB - newestA;
    });
    return out;
  }

  private filtered(serverKey: string): SessionSummary[] {
    return filterSessions(this.cache[serverKey] ?? [], this.filterText);
  }

  private newestActive(serverKey: string): number {
    const list = this.cache[serverKey] ?? [];
    return list.length > 0 ? Math.max(...list.map((s) => s.last_active)) : 0;
  }
}
