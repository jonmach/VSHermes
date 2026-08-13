/**
 * VSHermes — extension host entry point.
 *
 * Owns the HermesClient (single instance), the active session, the streaming
 * run state (abort + run_id for stop/approval), sync checking, and routes
 * messages between the webview and the API server.
 */

import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { HermesApiError, HermesClient, StreamHandle } from './api/client';
import { checkSync, MANIFEST, SyncReport } from './api/sync';
import type {
  Capabilities,
  ChatMessage,
  HealthStatus,
  MessagePart,
  SessionSummary,
  StreamEvent,
} from './api/types';
import {
  clearApiKey,
  getApiKey,
  getActiveEndpoint,
  getBaseUrl,
  getCheckSyncOnStartup,
  getEndpointApiKey,
  getEndpoints,
  getImageTransferMode,
  getLocalUrl,
  getMaxImageBytes,
  getMaxImageDimension,
  promptForApiKey,
  saveEndpoints,
  setActiveEndpoint,
  setEndpointApiKey,
} from './config';
import { canonicalUrl, isRemoteUrl, LOCAL_ENDPOINT_ID, makeEndpointId, normalizeUrl } from './endpointCore';
import { SLASH_COMMANDS, SlashHandlerId } from './slash/commands';
import { currentServerTarget, sessionTargetFromArg, type SessionTarget } from './sessionArg';
import { StatusBar } from './statusbar';
import { resolveHermesEnv } from './hermesEnv';
import { buildMessage, resolveImageMode } from './imageTransfer';
import { expandFileTokens } from './attach';
import { messagesToMarkdown } from './exportMarkdown';
import { enrichImageRefs } from './imageRefs';
import { ChatViewProvider } from './views/chatProvider';
import { HistoryProvider } from './views/historyProvider';
import { EndpointsPanel } from './endpointsPanel';
import type { FileEntry, HostMessage, WebviewMessage } from './views/media/protocol';
import type { EndpointsWebviewMessage } from './views/media/protocol';

export function activate(context: vscode.ExtensionContext): VSHermes {
  return new VSHermes(context);
}

class VSHermes {
  readonly context: vscode.ExtensionContext;
  readonly statusBar: StatusBar;
  readonly view: ChatViewProvider;
  readonly history: HistoryProvider;
  readonly endpointsPanel: EndpointsPanel;

  private client: HermesClient | null = null;
  private sessionId: string | null = null;
  private activeRunId: string | null = null;
  private stream: StreamHandle | null = null;
  private syncReport: SyncReport | null = null;
  private health: HealthStatus | null = null;
  private caps: Capabilities | null = null;
  /** Base URL the current session was established against — endpoint
   *  switches that change it reset the session (server-scoped ids). */
  private lastBaseUrl: string | null = null;
  /** The "/help" welcome posts once per activation, not per reconnect. */
  private welcomed = false;
  /** Signature of the last transcript snapshot posted to the webview —
   *  the polling loop only re-posts when the session's messages changed. */
  private lastTranscriptSig: {
    sessionId: string;
    count: number;
    lastId: string | null;
    lastTs: number | null;
  } | null = null;
  private readonly log = vscode.window.createOutputChannel('VSHermes');

  /** Observable test surface — exposed via extension.exports. */
  get lastSyncReport(): SyncReport | null {
    return this.syncReport;
  }
  get isConnected(): boolean {
    return this.client !== null && this.health !== null;
  }
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.statusBar = new StatusBar('vsh.hermes.focusChat');
    this.view = new ChatViewProvider(context.extensionUri);
    this.history = new HistoryProvider({
      endpointLabel: (url) => this.endpointForUrl(url).label,
      endpointRemote: (url) => isRemoteUrl(url),
      endpointIdForUrl: (url) => this.endpointForUrl(url).id,
    });
    this.endpointsPanel = new EndpointsPanel(context.extensionUri);

    context.subscriptions.push(
      this.statusBar,
      this.view,
      this.endpointsPanel,
      this.log,
      vscode.window.registerWebviewViewProvider('vsh.hermes.chat', this.view, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.window.createTreeView('vsh.hermes.history', {
        treeDataProvider: this.history,
        showCollapseAll: false,
      }),
      this.view.onDidReceiveMessage((msg) => void this.handleWebviewMessage(msg)),
      this.endpointsPanel.onDidReceiveMessage((msg) => void this.handleEndpointMessage(msg)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('vsh.hermes.baseUrl') ||
          e.affectsConfiguration('vsh.hermes.endpoints') ||
          e.affectsConfiguration('vsh.hermes.activeEndpoint')
        ) {
          this.noteEndpointChange();
          this.client = null;
          void this.connectAndSync();
          this.view.post(this.chatState());
          void this.refreshEndpointsPanel();
        }
      }),
      vscode.commands.registerCommand('vsh.hermes.focusChat', () => this.focusChat()),
      vscode.commands.registerCommand('vsh.hermes.newSession', () => void this.newSession()),
      vscode.commands.registerCommand('vsh.hermes.openHistory', () => this.focusHistory()),
      vscode.commands.registerCommand('vsh.hermes.refreshSessions', () => void this.listSessions()),
      vscode.commands.registerCommand('vsh.hermes.openSession', (arg: unknown) => {
        const target = sessionTargetFromArg(arg);
        if (target) void this.openSessionTarget(target);
      }),
      vscode.commands.registerCommand('vsh.hermes.forkSession', (arg?: unknown) => {
        const target = sessionTargetFromArg(arg);
        if (target) void this.forkSessionTarget(target);
      }),
      vscode.commands.registerCommand('vsh.hermes.deleteSession', (arg?: unknown) => {
        const target = sessionTargetFromArg(arg);
        if (target) void this.deleteSessionTarget(target);
      }),
      vscode.commands.registerCommand('vsh.hermes.checkSync', () => void this.checkSyncCommand()),
      vscode.commands.registerCommand('vsh.hermes.setApiKey', () => void this.setApiKeyFlow()),
      vscode.commands.registerCommand('vsh.hermes.chooseModel', () => void this.chooseModel()),
      vscode.commands.registerCommand('vsh.hermes.exportSession', () => void this.exportSession()),
      vscode.commands.registerCommand('vsh.hermes.searchHistory', () => void this.searchHistory()),
      vscode.commands.registerCommand('vsh.hermes.copyConversation', () => void this.copyConversation()),
      vscode.commands.registerCommand('vsh.hermes.attachFiles', () => void this.attachFiles()),
      vscode.commands.registerCommand('vsh.hermes.endpoints', () => this.endpointsPanel.toggle()),
    );

    this.statusBar.connecting();
    this.lastBaseUrl = getBaseUrl();
    this.log.appendLine(`VSHermes ${this.pluginVersion} activating… baseUrl=${getBaseUrl()}`);
    this.startHealthPolling();
    this.startTranscriptPolling();
    void this.connectAndSync();
  }

  private logInfo(msg: string): void {
    this.log.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  }

  private get pluginVersion(): string {
    return (this.context.extension.packageJSON.version as string) ?? '0.0.0';
  }

  // ── connection ────────────────────────────────────────────────────

  /** Reconnect + resync. Concurrent callers for the SAME server share one
   *  run — endpoint switches fire both the settings handler and the switch
   *  flow. A caller for a DIFFERENT server never reuses an in-flight run
   *  (its client would be stale). */
  private connectPromise: { url: string; promise: Promise<void> } | null = null;

  private connectAndSync(): Promise<void> {
    const url = getBaseUrl();
    const existing = this.connectPromise;
    if (existing && existing.url === url) return existing.promise;
    const run = this.doConnectAndSync().finally(() => {
      if (this.connectPromise?.promise === run) this.connectPromise = null;
    });
    this.connectPromise = { url, promise: run };
    return run;
  }

  private async doConnectAndSync(): Promise<void> {
    try {
      const c = await this.ensureClient();
      this.health = await c.health();
      this.caps = await c.capabilities();
      this.statusBar.connected(this.health.version, this.caps.model);
      this.logInfo(`connected to Hermes ${this.health.version} at ${getBaseUrl()}`);
      // The webview flipped to "offline" the moment a switch started
      // (client was nulled); a successful connect must push connected:true
      // or the badge stays stale until a health-poll transition.
      this.view.post(this.chatState());
      if (getCheckSyncOnStartup() && !this.welcomed) {
        this.welcomed = true;
        this.view.postInfo(`Connected to Hermes ${this.health.version}. Type /help for commands.`);
      }
    } catch (err) {
      this.health = null;
      this.caps = null;
      const msg = (err as Error).message;
      this.statusBar.offline(msg);
      this.logInfo(`connection failed: ${msg}`);
      const unreachable = err instanceof HermesApiError && err.code === 'connection_failed';
      this.view.post({
        type: 'error',
        message: unreachable
          ? `Cannot reach Hermes at ${getBaseUrl()} — is the gateway running? Try: hermes gateway run`
          : msg,
      });
      this.view.post(this.chatState());
      return;
    }
    await this.runSyncCheck(false);
    void this.listSessions();
  }

  /** Full chat state snapshot (ready + every endpoint/connection change). */
  private chatState(): Extract<HostMessage, { type: 'state' }> {
    return {
      type: 'state',
      connected: this.isConnected,
      baseUrl: getBaseUrl(),
      remote: isRemoteUrl(getBaseUrl()),
      syncReport: this.syncReport,
      sessionId: this.sessionId,
      model: this.caps?.model ?? null,
      sessions: [],
      slashCommands: SLASH_COMMANDS,
      maxImageBytes: getMaxImageBytes(),
      maxImageDimension: getMaxImageDimension(),
    };
  }

  // ── endpoints panel ──────────────────────────────────────────────

  private async handleEndpointMessage(msg: EndpointsWebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          await this.refreshEndpointsPanel();
          break;
        case 'diag':
          this.logInfo(`endpoints panel [${msg.level}]: ${msg.message}`);
          if (msg.level === 'error') {
            this.endpointsPanel.post({
              type: 'note',
              text: `Panel script error: ${msg.message}`,
            });
          }
          break;
        case 'add': {
          const url = normalizeUrl(msg.url);
          if (!url) {
            this.endpointsPanel.post({
              type: 'note',
              text: `Invalid URL "${msg.url}" — include http:// or https://`,
            });
            break;
          }
          const endpoints = getEndpoints();
          endpoints.push({ id: makeEndpointId(msg.name), name: msg.name.trim(), url });
          try {
            await saveEndpoints(endpoints);
          } catch (err) {
            this.endpointsPanel.post({ type: 'note', text: `Could not save endpoint: ${(err as Error).message}` });
            break;
          }
          this.afterEndpointsChanged();
          break;
        }
        case 'update': {
          const url = normalizeUrl(msg.url);
          if (!url) {
            this.endpointsPanel.post({ type: 'note', text: `Invalid URL "${msg.url}" — include http:// or https://` });
            break;
          }
          try {
            await saveEndpoints(
              getEndpoints().map((e) => (e.id === msg.id ? { ...e, name: msg.name.trim(), url } : e)),
            );
          } catch (err) {
            this.endpointsPanel.post({ type: 'note', text: `Could not save endpoint: ${(err as Error).message}` });
            break;
          }
          this.afterEndpointsChanged();
          break;
        }
        case 'remove': {
          await saveEndpoints(getEndpoints().filter((e) => e.id !== msg.id));
          if (getActiveEndpoint()?.id === msg.id) setActiveEndpoint(null);
          this.afterEndpointsChanged();
          break;
        }
        case 'setActive':
          await setActiveEndpoint(msg.id);
          this.afterEndpointsChanged();
          break;
        case 'setKey': {
          if (msg.key.trim()) await setEndpointApiKey(this.context, msg.id, msg.key.trim());
          await this.refreshEndpointsPanel();
          // A cached client holds the credential from connect time — if the
          // key just changed for the ACTIVE endpoint, rebuild the connection
          // so the chat uses the new key immediately (otherwise sends keep
          // 401ing with the stale credential while Test — which resolves the
          // key fresh — reports the saved key as valid).
          if (msg.id === this.currentEndpointId() || (msg.id === LOCAL_ENDPOINT_ID && getActiveEndpoint() === null)) {
            this.client = null;
            this.health = null;
            await this.connectAndSync();
          }
          break;
        }
        case 'test':
          await this.testEndpoint(msg.id);
          break;
      }
    } catch (err) {
      this.logInfo(`endpoint message failed: ${(err as Error).message}`);
      this.endpointsPanel.post({
        type: 'note',
        text: `Endpoint action failed: ${(err as Error).message}`,
      });
    }
  }

  /** Endpoint store changed → reconnect and refresh every surface (chat
   *  state incl. the remote flag, panel). */
  private afterEndpointsChanged(): void {
    this.noteEndpointChange();
    this.client = null;
    void this.connectAndSync();
    this.view.post(this.chatState());
    void this.refreshEndpointsPanel();
  }

  /** Reset the current session when the active base URL changed — session
   *  ids are server-scoped, so a switched endpoint must start fresh. */
  private noteEndpointChange(): void {
    const prev = this.lastBaseUrl;
    const next = getBaseUrl();
    if (prev !== null && prev !== next && this.sessionId) {
      this.sessionId = null;
      this.view.postInfo(`Switched endpoint (${prev} → ${next}) — the previous session stays on its server.`);
    }
    this.lastBaseUrl = next;
  }

  /** The endpoint id the active connection is on ('local' = legacy chain). */
  private currentEndpointId(): string {
    return getActiveEndpoint()?.id ?? LOCAL_ENDPOINT_ID;
  }

  /** Resolve a server URL (session-cache key) to an endpoint id + label.
   *  Two profiles pointing at the same server share one identity, so the
   *  first matching profile wins. */
  private endpointForUrl(url: string): { id: string; label: string } {
    const canonical = canonicalUrl(url);
    const profile = getEndpoints().find((e) => canonicalUrl(e.url) === canonical);
    if (profile) return { id: profile.id, label: profile.name };
    return { id: LOCAL_ENDPOINT_ID, label: 'Local' };
  }

  /** Switch the active endpoint (auto-switch on session open) and wait for
   *  the connection to land; false when the target is unreachable. */
  private async switchToEndpoint(endpointId: string): Promise<boolean> {
    if (endpointId === this.currentEndpointId()) return this.isConnected;
    await setActiveEndpoint(endpointId === LOCAL_ENDPOINT_ID ? null : endpointId);
    this.noteEndpointChange();
    this.client = null;
    await this.connectAndSync();
    this.view.post(this.chatState());
    void this.refreshEndpointsPanel();
    return this.isConnected;
  }

  // ── session cache (history grouped per server) ───────────────────

  /** Cached sessions keyed by canonical server URL (not endpoint id — two
   *  profiles on one server must collapse into a single section). */
  private getSessionCache(): Record<string, SessionSummary[]> {
    const raw = this.context.globalState.get<Record<string, SessionSummary[]>>(
      'vsh.hermes.sessionsByEndpoint',
      {},
    );
    // Drop legacy endpoint-id keys (pre-URL-keying caches).
    const out: Record<string, SessionSummary[]> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (/^https?:\/\//i.test(k)) out[k] = v;
    }
    return out;
  }

  private async setSessionCache(cache: Record<string, SessionSummary[]>): Promise<void> {
    await this.context.globalState.update('vsh.hermes.sessionsByEndpoint', cache);
  }

  private async refreshEndpointsPanel(): Promise<void> {
    const keySet: string[] = [];
    for (const ep of getEndpoints()) {
      if (await getEndpointApiKey(this.context, ep.id)) keySet.push(ep.id);
    }
    this.endpointsPanel.post({
      type: 'state',
      endpoints: getEndpoints(),
      activeId: getActiveEndpoint()?.id ?? null,
      keySet,
      remote: isRemoteUrl(getBaseUrl()),
      connected: this.isConnected,
      baseUrl: getBaseUrl(),
      localUrl: getLocalUrl(),
    });
  }

  /** Reachability + version probe for a profile (does not switch to it). */
  private async testEndpoint(id: string): Promise<void> {
    const ep =
      id === LOCAL_ENDPOINT_ID
        ? { id: LOCAL_ENDPOINT_ID, name: 'Local connection', url: getLocalUrl() }
        : getEndpoints().find((e) => e.id === id);
    if (!ep) return;
    const key =
      id === LOCAL_ENDPOINT_ID
        ? (await getApiKey(this.context)).key
        : (await getEndpointApiKey(this.context, ep.id)) ?? (await getApiKey(this.context)).key;
    try {
      const res = await fetch(`${ep.url}/health`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json()) as { status?: string; version?: string };
      if (!(res.ok && body.status === 'ok')) {
        this.endpointsPanel.post({
          type: 'testResult',
          id,
          ok: false,
          detail: `HTTP ${res.status} — check that the gateway exposes api_server`,
        });
        return;
      }
      // /health is unauthenticated — reachability alone must not be a green
      // light. Probe an authenticated route to validate the key (or confirm
      // the server requires none).
      const auth = await fetch(`${ep.url}/api/sessions?limit=1`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (auth.ok) {
        const note = key ? ' (key valid)' : ' (no API key required)';
        this.endpointsPanel.post({
          type: 'testResult',
          id,
          ok: true,
          detail: `OK — Hermes ${body.version ?? '?'} at ${ep.url}${note}`,
        });
      } else if (auth.status === 401 || auth.status === 403) {
        this.endpointsPanel.post({
          type: 'testResult',
          id,
          ok: false,
          detail: `Reachable, but the API key is missing or wrong (HTTP ${auth.status}) — enter it above and Save key`,
        });
      } else {
        this.endpointsPanel.post({
          type: 'testResult',
          id,
          ok: false,
          detail: `Reachable, but an authenticated probe failed (HTTP ${auth.status})`,
        });
      }
    } catch (err) {
      this.endpointsPanel.post({
        type: 'testResult',
        id,
        ok: false,
        detail: `Unreachable: ${(err as Error).message}`,
      });
    }
  }

  // ── gateway health polling ────────────────────────────────────────

  /** Every 30s, check /health and flip connection state on change. */
  private startHealthPolling(): void {
    const timer = setInterval(() => void this.pollHealth(), 30_000);
    this.context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  private async pollHealth(): Promise<void> {
    if (!this.client) return; // nothing to monitor until first connect
    const wasOnline = this.health !== null;
    try {
      const c = this.client;
      const h = await c.health();
      if (!wasOnline) {
        // Gateway came back — refresh capabilities, sync and the UI.
        this.health = h;
        this.caps = await c.capabilities();
        this.statusBar.connected(h.version, this.caps.model);
        await this.runSyncCheck(true);
        void this.listSessions();
        let model: string | null = this.caps.model ?? null;
        if (this.sessionId) {
          const s = await c.getSession(this.sessionId).catch(() => null);
          if (s?.session.model) model = s.session.model;
        }
        this.view.post({
          type: 'state', connected: true, baseUrl: getBaseUrl(), remote: isRemoteUrl(getBaseUrl()), syncReport: this.syncReport,
          sessionId: this.sessionId, model, sessions: [], slashCommands: SLASH_COMMANDS,
          maxImageBytes: getMaxImageBytes(), maxImageDimension: getMaxImageDimension(),
        });
        this.view.postInfo('Reconnected to Hermes.');
      } else {
        this.health = h;
      }
    } catch {
      if (wasOnline) {
        this.health = null;
        this.statusBar.offline('gateway unreachable');
        this.view.post({
          type: 'state', connected: false, baseUrl: getBaseUrl(), remote: isRemoteUrl(getBaseUrl()), syncReport: this.syncReport,
          sessionId: this.sessionId, model: null, sessions: [], slashCommands: SLASH_COMMANDS,
          maxImageBytes: getMaxImageBytes(), maxImageDimension: getMaxImageDimension(),
        });
      }
    }
  }

  // ── open-session transcript polling ───────────────────────────────

  /** Every 10s, refresh the open session's messages while idle. A session
   *  written by another client (the TUI, a second window) updates in place
   *  — new turns and tool cards appear — instead of staying a stale
   *  snapshot until the session is reopened or History is refreshed. */
  private startTranscriptPolling(): void {
    const timer = setInterval(() => void this.maybeRefreshTranscript(), 10_000);
    this.context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  private async maybeRefreshTranscript(): Promise<void> {
    // Never clobber the live stream renderer, and only poll an open session.
    if (!this.sessionId || this.stream || !this.isConnected) return;
    try {
      const c = await this.ensureClient();
      const msgs = await c.sessionMessages(this.sessionId, 500);
      const last = msgs.data.length > 0 ? msgs.data[msgs.data.length - 1] : null;
      const sig = {
        sessionId: this.sessionId,
        count: msgs.data.length,
        lastId: last?.id != null ? String(last.id) : null,
        lastTs: last?.timestamp ?? null,
      };
      const prev = this.lastTranscriptSig;
      this.lastTranscriptSig = sig;
      if (
        prev &&
        prev.sessionId === sig.sessionId &&
        prev.count === sig.count &&
        prev.lastId === sig.lastId &&
        prev.lastTs === sig.lastTs
      ) {
        return; // unchanged — no re-render
      }
      this.postTranscript(sig.sessionId, msgs.data);
    } catch {
      // Non-fatal — the next tick retries.
    }
  }

  /** Post a full transcript snapshot and remember its signature. */
  private postTranscript(sessionId: string, messages: ChatMessage[]): void {
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    this.lastTranscriptSig = {
      sessionId,
      count: messages.length,
      lastId: last?.id != null ? String(last.id) : null,
      lastTs: last?.timestamp ?? null,
    };
    this.view.post({
      type: 'messages',
      sessionId,
      messages: messages.map((m) => ({
        ...m,
        content: enrichImageRefs(m.content, (p) => this.view.asImageUri(p)),
      })),
    });
  }

  // ── export ────────────────────────────────────────────────────────

  private async exportSession(): Promise<void> {
    const sid = this.sessionId;
    if (!sid) {
      vscode.window.showWarningMessage('No active session to export — open one from History first.');
      return;
    }
    try {
      const c = await this.ensureClient();
      const [msgs, session] = await Promise.all([
        c.sessionMessages(sid),
        c.getSession(sid).catch(() => null),
      ]);
      const s = session?.session ?? null;
      const md = messagesToMarkdown(msgs.data, s);
      const safeTitle =
        (s?.title ?? `hermes-session-${sid.slice(0, 8)}`).replace(/[\\/:*?"<>|]+/g, '-').trim() ||
        'hermes-session';
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(folder, `${safeTitle}.md`),
        filters: { Markdown: ['md'] },
      });
      if (!uri) return; // user cancelled
      await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
      this.view.postInfo(`Session exported to ${uri.fsPath}`);
    } catch (err) {
      this.reportError(err);
    }
  }

  private async searchHistory(): Promise<void> {
    const current = this.history.filterActive ? this.history.filter : '';
    const q = await vscode.window.showInputBox({
      title: 'Filter History',
      prompt: 'Match by title, id, model or source. Empty input clears the filter.',
      value: current,
    });
    if (q === undefined) return; // cancelled
    this.history.setFilter(q);
  }

  private async copyConversation(): Promise<void> {
    const sid = this.sessionId;
    if (!sid) {
      vscode.window.showWarningMessage('No active session to copy — open one from History first.');
      return;
    }
    try {
      const c = await this.ensureClient();
      const [msgs, session] = await Promise.all([
        c.sessionMessages(sid),
        c.getSession(sid).catch(() => null),
      ]);
      const md = messagesToMarkdown(msgs.data, session?.session ?? null);
      await vscode.env.clipboard.writeText(md);
      this.view.postInfo(`Conversation copied to the clipboard (${msgs.data.length} messages).`);
    } catch (err) {
      this.reportError(err);
    }
  }

  /** @file picker: workspace files matching the query (relative paths). */
  private async handleFileQuery(query: string): Promise<void> {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        this.view.post({ type: 'fileResults', query, files: [] });
        return;
      }
      const q = query.trim().toLowerCase();
      const uris = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git}/**',
        500,
      );
      const files: FileEntry[] = uris
        .map((u) => {
          for (const f of folders) {
            const rel = path.relative(f.uri.fsPath, u.fsPath);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
              return { rel: rel.split(path.sep).join('/'), abs: u.fsPath };
            }
          }
          return null;
        })
        .filter((r): r is FileEntry => r !== null)
        .filter((r) => (q ? r.rel.toLowerCase().includes(q) : true))
        .sort((a, b) => a.rel.localeCompare(b.rel))
        .slice(0, 50);
      this.view.post({ type: 'fileResults', query, files });
    } catch {
      this.view.post({ type: 'fileResults', query, files: [] });
    }
  }

  /** Paperclip / palette: pick file(s) anywhere → insert `@file <path>` attach
   *  tokens. The copy into attachments happens at send time. Hard-disabled
   *  on remote endpoints (no upload channel to the gateway). */
  private async attachFiles(): Promise<void> {
    if (isRemoteUrl(getBaseUrl())) {
      void vscode.window.showWarningMessage(
        "File attach isn't available on remote endpoints — the gateway can't receive files. Use a @path reference if the file exists on the remote machine.",
      );
      return;
    }
    try {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: 'Attach',
        title: 'VSHermes — attach file(s)',
      });
      if (!picked || picked.length === 0) return;
      this.view.post({ type: 'insertTokens', tokens: picked.map((u) => `@file ${u.fsPath}`) });
    } catch (err) {
      this.reportError(err);
    }
  }

  /** `@` picker "Browse…": pick a file or folder → insert a plain `@<path>`
   *  reference (never copied — the LLM reads it in place). */
  private async browseReference(): Promise<void> {
    try {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Reference',
        title: 'VSHermes — reference a file or folder',
      });
      this.view.post({ type: 'browseResult', path: picked?.[0]?.fsPath ?? null });
    } catch (err) {
      this.view.post({ type: 'browseResult', path: null });
      this.reportError(err);
    }
  }

  private async ensureClient(url?: string): Promise<HermesClient> {
    const want = url ?? getBaseUrl();
    // Rebuild when the requested server differs from the cached client's —
    // a stale client would query the wrong server after an endpoint switch.
    if (this.client && canonicalUrl(this.client.baseUrl) === canonicalUrl(want)) {
      return this.client;
    }
    const baseUrl = want;
    const { key, source } = await getApiKey(this.context);
    if (!key) {
      const prompted = await promptForApiKey(this.context);
      if (!prompted) {
        throw new Error(
          'No API key configured — checked SecretStorage, VSHERMES_API_KEY and the Hermes .env. ' +
            'Run "VSHermes: Set API Key" to provide API_SERVER_KEY manually.',
        );
      }
      this.logInfo('API key provided via prompt (stored in SecretStorage).');
      this.client = new HermesClient(baseUrl, prompted);
      return this.client;
    }
    const envFile = source === 'hermes-env' ? resolveHermesEnv()?.envFile : undefined;
    this.logInfo(
      `API key resolved from ${source}${envFile ? ` (${envFile})` : ''} — baseUrl ${baseUrl}`,
    );
    this.client = new HermesClient(baseUrl, key);
    return this.client;
  }

  private async setApiKeyFlow(): Promise<void> {
    const pick = await vscode.window.showQuickPick(['Set new API key', 'Clear API key'], {
      placeHolder: 'VSHermes API key',
    });
    if (pick === 'Clear API key') {
      await clearApiKey(this.context);
      this.client = null;
      this.view.postInfo('API key cleared.');
      return;
    }
    if (pick === 'Set new API key' || pick === undefined) {
      const key = await promptForApiKey(this.context);
      if (key) {
        this.client = null;
        this.statusBar.connecting();
        await this.connectAndSync();
      }
    }
  }

  private async checkSyncCommand(): Promise<void> {
    await this.runSyncCheck(true);
    await this.notifySyncResult();
  }

  // ── sync check (out-of-sync flagging) ─────────────────────────────

  private async runSyncCheck(force = false): Promise<void> {
    if (!force) {
      const cached = this.context.workspaceState.get<SyncReport>('vsh.hermes.syncReport');
      if (cached && Date.now() - cached.checkedAt < 60_000) {
        this.syncReport = cached;
        this.applySyncReport();
        return;
      }
    }
    try {
      const c = await this.ensureClient();
      const health = this.health ?? (await c.health());
      const caps = this.caps ?? (await c.capabilities());
      const report = checkSync(health, caps, MANIFEST, this.pluginVersion);
      this.syncReport = report;
      await this.context.workspaceState.update('vsh.hermes.syncReport', report);
      this.applySyncReport();
    } catch (err) {
      this.view.post({ type: 'error', message: `Sync check failed: ${(err as Error).message}` });
    }
  }

  private applySyncReport(): void {
    const r = this.syncReport;
    if (!r) return;
    if (r.status === 'outdated') {
      this.statusBar.syncWarning(r.messages.join(' '));
    } else if (r.status === 'ok' || r.status === 'ahead') {
      this.statusBar.connected(this.health?.version ?? r.hermesVersion, this.caps?.model ?? null);
    }
    this.logInfo(`sync check: ${r.status} — ${r.messages.join(' ')}`);
    this.view.post({ type: 'sync', report: r });
  }

  /** Visible feedback for the Check Sync command — silent success was a UX gap. */
  private async notifySyncResult(): Promise<void> {
    const r = this.syncReport;
    if (!r) return;
    const hermes = r.hermesVersion ? `Hermes ${r.hermesVersion}` : 'Hermes';
    if (r.status === 'ok') {
      await vscode.window.showInformationMessage(`VSHermes ${r.pluginVersion} is in sync with ${hermes}.`);
    } else if (r.status === 'outdated') {
      await vscode.window.showWarningMessage(`VSHermes out of sync with ${hermes}: ${r.messages.join(' ')}`, 'Check details');
    } else if (r.status === 'ahead') {
      await vscode.window.showInformationMessage(`VSHermes is older than ${hermes}: ${r.messages.join(' ')}`);
    } else {
      await vscode.window.showErrorMessage('VSHermes sync check failed: Hermes API server unreachable.');
    }
  }

  // ── sessions ──────────────────────────────────────────────────────

  private async listSessions(): Promise<SessionSummary[]> {
    try {
      const c = await this.ensureClient();
      // Key by the server we ACTUALLY queried (captured at fetch time), not
      // getBaseUrl() at write time — an endpoint switch mid-fetch would
      // otherwise store the old server's sessions under the new server's
      // key (the "Docker — remote (200) full of local sessions" bug).
      const url = canonicalUrl(c.baseUrl);
      const res = await c.listSessions(200);
      const cache = this.getSessionCache();
      cache[url] = res.data;
      await this.setSessionCache(cache);
      this.history.refresh(cache);
      this.view.post({ type: 'sessions', sessions: res.data });
      return res.data;
    } catch (err) {
      this.reportError(err);
      return [];
    }
  }

  /** Open a session anywhere — auto-switches to its server first. */
  private async openSessionTarget(target: SessionTarget): Promise<void> {
    if (target.endpointId !== null && target.endpointId !== this.currentEndpointId()) {
      const ok = await this.switchToEndpoint(target.endpointId);
      if (!ok) return; // unreachable — connectAndSync surfaced the error
    }
    await this.openSession(target.sessionId);
  }

  /** Delete a session anywhere — auto-switches to its server first. */
  private async deleteSessionTarget(target: SessionTarget): Promise<void> {
    if (target.endpointId !== null && target.endpointId !== this.currentEndpointId()) {
      const ok = await this.switchToEndpoint(target.endpointId);
      if (!ok) return;
    }
    await this.deleteSession(target.sessionId);
  }

  /** Fork a session anywhere — auto-switches to its server first. */
  private async forkSessionTarget(target: SessionTarget): Promise<void> {
    if (target.endpointId !== null && target.endpointId !== this.currentEndpointId()) {
      const ok = await this.switchToEndpoint(target.endpointId);
      if (!ok) return;
    }
    await this.forkSession(target.sessionId);
  }

  private async newSession(): Promise<void> {
    this.abortStream();
    try {
      const c = await this.ensureClient();
      const res = await c.createSession();
      this.sessionId = res.session.id;
      this.activeRunId = null;
      this.view.post({ type: 'state', connected: true, baseUrl: getBaseUrl(), remote: isRemoteUrl(getBaseUrl()), syncReport: this.syncReport, sessionId: this.sessionId, model: res.session.model, sessions: [], slashCommands: SLASH_COMMANDS, maxImageBytes: getMaxImageBytes(), maxImageDimension: getMaxImageDimension() });
      void this.listSessions();
    } catch (err) {
      this.reportError(err);
    }
  }

  private async openSession(id: string): Promise<void> {
    this.abortStream();
    this.sessionId = id;
    this.activeRunId = null;
    try {
      const c = await this.ensureClient();
      const [msgs, session] = await Promise.all([
        c.sessionMessages(id),
        c.getSession(id).catch(() => null),
      ]);
      this.postTranscript(id, msgs.data);
      this.view.post({ type: 'state', connected: true, baseUrl: getBaseUrl(), remote: isRemoteUrl(getBaseUrl()), syncReport: this.syncReport, sessionId: id, model: session?.session.model ?? null, sessions: [], slashCommands: SLASH_COMMANDS, maxImageBytes: getMaxImageBytes(), maxImageDimension: getMaxImageDimension() });
      this.focusChat();
    } catch (err) {
      this.reportError(err);
    }
  }

  private async deleteSession(id?: string): Promise<void> {
    const target = id ?? this.sessionId;
    if (!target) return;
    const ok = await vscode.window.showWarningMessage(
      `Delete Hermes session ${target}?`,
      { modal: true },
      'Delete',
    );
    if (ok !== 'Delete') return;
    try {
      const c = await this.ensureClient();
      await c.deleteSession(target);
      if (this.sessionId === target) {
        this.sessionId = null;
        this.view.post({ type: 'state', connected: true, baseUrl: getBaseUrl(), remote: isRemoteUrl(getBaseUrl()), syncReport: this.syncReport, sessionId: null, model: null, sessions: [], slashCommands: SLASH_COMMANDS, maxImageBytes: getMaxImageBytes(), maxImageDimension: getMaxImageDimension() });
      }
      void this.listSessions();
    } catch (err) {
      this.reportError(err);
    }
  }

  private async forkSession(id?: string): Promise<void> {
    const target = id ?? this.sessionId;
    if (!target) return;
    try {
      const c = await this.ensureClient();
      const res = await c.forkSession(target);
      await this.openSession(res.session.id);
      void this.listSessions();
    } catch (err) {
      this.reportError(err);
    }
  }

  // ── chat / streaming ──────────────────────────────────────────────

  private async send(parts: MessagePart[], sessionId?: string): Promise<void> {
    if (sessionId) {
      this.sessionId = sessionId;
      this.activeRunId = null;
    }
    // Remote endpoints have no upload channel — @file attach is a hard
    // restriction (the gateway can't receive files). @<path> references are
    // plain text and remain allowed.
    const remote = isRemoteUrl(getBaseUrl());
    if (remote) {
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      if (/@file\s+\S/.test(text)) {
        this.view.post({
          type: 'error',
          message:
            "File attach isn't available on remote endpoints — the gateway can't receive files. Remove the @file mention, or use a @path reference if the file exists on the remote machine.",
        });
        return;
      }
    }
    // Image transfer strategy: text-only main models reject image_url parts
    // with 400, so file mode saves images to disk and references the path
    // (the agent's own vision fallback chain does the analysis). Remote
    // endpoints force inline — file mode needs a shared filesystem.
    try {
      const mode = remote ? 'inline' : resolveImageMode(getImageTransferMode(), await this.modelVisionCaps());
      const home = resolveHermesEnv()?.homeDir ?? os.tmpdir();
      const attachDir = path.join(home, 'attachments');
      if (remote && parts.some((p) => p.type === 'image_url') && getImageTransferMode() !== 'inline') {
        this.view.post({
          type: 'info',
          text: 'Remote endpoint: pasted images are sent inline (file mode needs a shared filesystem) — a vision-capable main model is required.',
        });
      }
      const { parts: transformed, written } = buildMessage(parts, mode, attachDir);
      if (written.length > 0) {
        this.logInfo(`image transfer (file mode) → ${written.join(', ')}`);
      }
      parts = transformed;
    } catch (err) {
      this.logInfo(`image transfer planning failed, sending as-is: ${(err as Error).message}`);
    }
    // @file attach expansion: copy mentioned files into attachments and
    // point the token at the copy — the message stays a small path per file
    // and the LLM loads the content when it decides to.
    try {
      const home = resolveHermesEnv()?.homeDir ?? os.tmpdir();
      const attachDir = path.join(home, 'attachments');
      const copied: string[] = [];
      const missing: string[] = [];
      parts = parts.map((p) => {
        if (p.type !== 'text') return p;
        const r = expandFileTokens(p.text, attachDir);
        copied.push(...r.copied);
        missing.push(...r.missing);
        return { ...p, text: r.text };
      });
      if (copied.length > 0) this.logInfo(`@file attach → ${copied.join(', ')}`);
      if (missing.length > 0) {
        void vscode.window.showWarningMessage(
          `VSHermes: ${missing.length} attached file(s) not found — sent as a path reference:\n${missing.join('\n')}\n\nIf you dragged them from the host filesystem (Finder), the container can't see them — drag them into the Explorer first, or use the attach button.`,
        );
      }
    } catch (err) {
      this.logInfo(`@file expansion failed, sending as-is: ${(err as Error).message}`);
    }
    let sid = this.sessionId;
    try {
      const c = await this.ensureClient();
      if (!sid) {
        const res = await c.createSession();
        sid = res.session.id;
        this.sessionId = sid;
        void this.listSessions();
      }
      this.abortStream();
      this.stream = c.sessionChatStream(sid, parts, (event) => this.onStreamEvent(event));
      try {
        await this.stream.done;
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          // Intentional stop (/stop, /new, session switch) — clean end, not an error.
          this.view.post({ type: 'stream:ended', sessionId: sid });
          return;
        }
        this.view.post({ type: 'stream:ended', sessionId: sid, error: (err as Error).message });
        this.reportError(err);
        return;
      }
      this.view.post({ type: 'stream:ended', sessionId: sid });
      this.logInfo(`stream ended (session ${sid})`);
      void this.refreshSessionAfterRun(sid);
    } catch (err) {
      this.reportError(err);
    }
  }

  private onStreamEvent(event: StreamEvent): void {
    if (event.type === 'run.started' && event.run_id) {
      this.activeRunId = event.run_id;
      this.logInfo(`run started: ${event.run_id}`);
    }
    this.view.post({ type: 'stream', event });
  }

  private visionCapsCache: Record<string, unknown> | null | undefined;

  /** Vision capability of the current provider/model, if the API tells us.
   *  Cached; undefined on failure (auto mode then falls back to file). */
  private async modelVisionCaps(): Promise<Record<string, unknown> | undefined> {
    if (this.visionCapsCache !== undefined) return this.visionCapsCache ?? undefined;
    try {
      const c = await this.ensureClient();
      const opts = await c.modelOptions();
      const prov = opts.providers.find((p) => p.is_current) ?? opts.providers[0];
      const firstModel = Array.isArray(prov?.models) ? prov.models[0] : undefined;
      const caps =
        firstModel && typeof firstModel === 'object' && 'capabilities' in firstModel
          ? (firstModel as { capabilities?: Record<string, unknown> }).capabilities
          : undefined;
      this.visionCapsCache = caps;
      this.logInfo(
        `model vision capabilities: ${caps ? JSON.stringify(caps) : 'unknown (auto→file)'}`,
      );
    } catch {
      this.visionCapsCache = undefined;
    }
    return this.visionCapsCache;
  }

  private async refreshSessionAfterRun(sid: string): Promise<void> {
    try {
      const c = await this.ensureClient();
      const msgs = await c.sessionMessages(sid);
      const session = await c.getSession(sid).catch(() => null);
      if (session) {
        this.view.post({ type: 'session', session: session.session });
      }
      this.postTranscript(sid, msgs.data);
      void this.listSessions();
    } catch {
      // Non-fatal: the stream already delivered everything.
    }
  }

  private stop(): void {
    this.abortStream();
    const runId = this.activeRunId;
    if (runId) {
      void this.ensureClient()
        .then((c) => c.stopRun(runId))
        .catch(() => undefined);
    }
  }

  private abortStream(): void {
    this.stream?.abort();
    this.stream = null;
  }

  private async approve(decision: 'once' | 'session' | 'always' | 'deny'): Promise<void> {
    const runId = this.activeRunId;
    if (!runId) {
      this.view.post({ type: 'error', message: 'No active run to approve.' });
      return;
    }
    try {
      const c = await this.ensureClient();
      await c.approveRun(runId, decision);
      this.view.postInfo(`Approval resolved: ${decision}.`);
    } catch (err) {
      this.reportError(err);
    }
  }

  // ── model switching ───────────────────────────────────────────────

  private async chooseModel(): Promise<void> {
    try {
      const c = await this.ensureClient();
      const opts = await c.modelOptions();
      const providers = opts.providers.filter((p) => p.authenticated || p.is_current);
      const provider = await vscode.window.showQuickPick(
        providers.map((p) => ({
          label: p.name,
          description: p.is_current ? 'current' : p.auth_type ?? '',
          detail: p.warning ?? undefined,
          provider: p,
        })),
        { placeHolder: 'Provider' },
      );
      if (!provider) return;
      const models = provider.provider.models.map((m) => m.id);
      const model = await vscode.window.showQuickPick(models, {
        placeHolder: `Model (${provider.provider.name})`,
      });
      if (!model) return;
      if (!this.sessionId) {
        await this.newSession();
        if (!this.sessionId) return;
      }
      await c.lockModel(this.sessionId, model);
      this.view.post({ type: 'model', model });
      this.view.postInfo(`Model locked to ${model} for this session.`);
    } catch (err) {
      this.reportError(err);
    }
  }

  // ── webview message routing ───────────────────────────────────────

  private async handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.logInfo('webview booted (ready received)');
        this.view.post(this.chatState());
        void this.listSessions();
        if (getCheckSyncOnStartup()) void this.runSyncCheck(false);
        break;
      case 'send':
        this.logInfo(
          `send received (session ${this.sessionId ?? 'new'}): ${previewOf(msg.parts)}`,
        );
        await this.send(msg.parts, msg.sessionId);
        break;
      case 'newSession':
        await this.newSession();
        break;
      case 'openSession':
        await this.openSessionTarget(currentServerTarget(msg.id));
        break;
      case 'deleteSession':
        await this.deleteSessionTarget(currentServerTarget(msg.id));
        break;
      case 'forkSession':
        if (this.sessionId) await this.forkSessionTarget(currentServerTarget(this.sessionId));
        break;
      case 'stop':
        this.stop();
        break;
      case 'approve':
        await this.approve(msg.decision);
        break;
      case 'setModel':
        if (this.sessionId) {
          try {
            const c = await this.ensureClient();
            await c.lockModel(this.sessionId, msg.model);
            this.view.post({ type: 'model', model: msg.model });
          } catch (err) {
            this.reportError(err);
          }
        }
        break;
      case 'chooseModel':
        await this.chooseModel();
        break;
      case 'skills':
        await this.handleSlashHandler('skills');
        break;
      case 'listSessions':
        void this.listSessions();
        break;
      case 'checkSync':
        await this.checkSyncCommand();
        break;
      case 'fileQuery':
        void this.handleFileQuery(msg.query);
        break;
      case 'attachDialog':
        await this.attachFiles();
        break;
      case 'browse':
        await this.browseReference();
        break;
      case 'focusHistory':
        this.focusHistory();
        break;
      case 'setTitle':
        await this.setTitle(msg.title);
        break;
      case 'showStatus':
        await this.showSessionStatus();
        break;
      case 'diag':
        this.logInfo(`webview [${msg.level}]: ${msg.message}`);
        if (msg.level === 'error') {
          await vscode.window.showErrorMessage(`VSHermes webview: ${msg.message}`);
        }
        break;
    }
  }

  // ── slash handlers ────────────────────────────────────────────────
  // The webview maps catalog entries (kind === 'action') to message types
  // itself; this method is the host-side implementation for the remaining
  // actions that have no dedicated message type (skills/help).

  async handleSlashHandler(handler: SlashHandlerId): Promise<void> {
    switch (handler) {
      case 'new-session':
      case 'clear-session':
        await this.newSession();
        break;
      case 'choose-model':
        await this.chooseModel();
        break;
      case 'stop':
        this.stop();
        break;
      case 'history':
        this.focusHistory();
        break;
      case 'skills': {
        try {
          const c = await this.ensureClient();
          const res = await c.listSkills();
          const names = res.data.map((s) => `- ${s.name}: ${s.description}`).join('\n');
          this.view.postInfo(`Skills visible to Hermes (${res.data.length}):\n${names}`);
        } catch (err) {
          this.reportError(err);
        }
        break;
      }
      case 'fork':
        await this.forkSession();
        break;
      case 'set-title':
        await this.setTitle('');
        break;
      case 'status':
        await this.showSessionStatus();
        break;
      case 'help':
        this.view.postInfo(
          'VSHermes slash commands:\n' +
            SLASH_COMMANDS.map((c) => `/${c.name} — ${c.summary}`).join('\n'),
        );
        break;
    }
  }

  // ── misc ──────────────────────────────────────────────────────────

  private focusChat(): void {
    void vscode.commands.executeCommand('vsh.hermes.chat.focus');
  }

  private focusHistory(): void {
    void Promise.resolve(vscode.commands.executeCommand('vsh.hermes.history.focus'))
      .then(() => this.logInfo('history view focused'))
      .catch(() => {
        this.logInfo('vsh.hermes.history.focus not available; falling back to container focus');
        void vscode.commands.executeCommand('workbench.view.extension.vsh-hermes');
      });
  }

  /** /title — set the current session's title via PATCH /api/sessions/{id}. */
  private async setTitle(rawTitle: string): Promise<void> {
    let title = rawTitle.trim();
    if (!title) {
      title =
        (await vscode.window.showInputBox({
          prompt: 'Session title',
          placeHolder: 'My Session Name',
        }))?.trim() ?? '';
      if (!title) return;
    }
    if (!this.sessionId) {
      await this.newSession();
      if (!this.sessionId) return;
    }
    try {
      const c = await this.ensureClient();
      const res = await c.patchSession(this.sessionId, { title });
      this.view.postInfo(`Session titled: ${res.session.title}`);
      void this.listSessions();
    } catch (err) {
      this.reportError(err);
    }
  }

  /** /status — show the current session's client-safe metadata in chat. */
  private async showSessionStatus(): Promise<void> {
    if (!this.sessionId) {
      this.view.postInfo('No active session — type a message to start one.');
      return;
    }
    try {
      const c = await this.ensureClient();
      const res = await c.getSession(this.sessionId);
      const s = res.session;
      const started = s.started_at ? new Date(s.started_at * 1000).toLocaleString() : '?';
      this.view.postInfo(
        `Session ${s.id}\nTitle: ${s.title ?? '(none)'}\nModel: ${s.model ?? '?'}\nMessages: ${s.message_count ?? 0}\nSource: ${s.source ?? '?'}\nStarted: ${started}`,
      );
    } catch (err) {
      this.reportError(err);
    }
  }

  private reportError(err: unknown): void {
    if (err instanceof HermesApiError) {
      const msg = `Hermes API error (${err.status}): ${err.message}`;
      this.logInfo(msg);
      this.view.post({ type: 'error', message: msg });
    } else {
      const msg = (err as Error).message;
      this.logInfo(`error: ${msg}`);
      this.view.post({ type: 'error', message: msg });
    }
  }
}

/** Short preview of an outbound message for the log. */
function previewOf(parts: MessagePart[]): string {
  const text = parts.find((p) => p.type === 'text')?.text ?? '';
  const images = parts.filter((p) => p.type === 'image_url').length;
  const t = text.replace(/\s+/g, ' ').trim();
  return `${t.slice(0, 80)}${t.length > 80 ? '…' : ''}${images ? ` [+${images} image${images > 1 ? 's' : ''}]` : ''}`;
}

export function deactivate(): void {
  // Streams abort when the webview disposes; nothing else to tear down.
}
