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
  getBaseUrl,
  getCheckSyncOnStartup,
  getImageTransferMode,
  getMaxImageBytes,
  getMaxImageDimension,
  promptForApiKey,
} from './config';
import { SLASH_COMMANDS, SlashHandlerId } from './slash/commands';
import { sessionIdFromArg } from './sessionArg';
import { StatusBar } from './statusbar';
import { resolveHermesEnv } from './hermesEnv';
import { buildMessage, resolveImageMode } from './imageTransfer';
import { ChatViewProvider } from './views/chatProvider';
import { HistoryProvider } from './views/historyProvider';
import type { WebviewMessage } from './views/media/protocol';

export function activate(context: vscode.ExtensionContext): VSHermes {
  return new VSHermes(context);
}

class VSHermes {
  readonly context: vscode.ExtensionContext;
  readonly statusBar: StatusBar;
  readonly view: ChatViewProvider;
  readonly history: HistoryProvider;

  private client: HermesClient | null = null;
  private sessionId: string | null = null;
  private activeRunId: string | null = null;
  private stream: StreamHandle | null = null;
  private syncReport: SyncReport | null = null;
  private health: HealthStatus | null = null;
  private caps: Capabilities | null = null;
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
    this.history = new HistoryProvider(() => this.listSessions());

    context.subscriptions.push(
      this.statusBar,
      this.view,
      this.log,
      vscode.window.registerWebviewViewProvider('vsh.hermes.chat', this.view, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.window.createTreeView('vsh.hermes.history', {
        treeDataProvider: this.history,
        showCollapseAll: false,
      }),
      this.view.onDidReceiveMessage((msg) => void this.handleWebviewMessage(msg)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('vsh.hermes.baseUrl')) {
          this.client = null;
          void this.connectAndSync();
        }
      }),
      vscode.commands.registerCommand('vsh.hermes.focusChat', () => this.focusChat()),
      vscode.commands.registerCommand('vsh.hermes.newSession', () => void this.newSession()),
      vscode.commands.registerCommand('vsh.hermes.openHistory', () => this.focusHistory()),
      vscode.commands.registerCommand('vsh.hermes.refreshSessions', () => void this.listSessions()),
      vscode.commands.registerCommand('vsh.hermes.openSession', (arg: unknown) => {
        const id = sessionIdFromArg(arg);
        if (id) void this.openSession(id);
      }),
      vscode.commands.registerCommand('vsh.hermes.forkSession', (arg?: unknown) => {
        const id = sessionIdFromArg(arg);
        if (id) void this.forkSession(id);
      }),
      vscode.commands.registerCommand('vsh.hermes.deleteSession', (arg?: unknown) => {
        const id = sessionIdFromArg(arg);
        if (id) void this.deleteSession(id);
      }),
      vscode.commands.registerCommand('vsh.hermes.checkSync', () => void this.checkSyncCommand()),
      vscode.commands.registerCommand('vsh.hermes.setApiKey', () => void this.setApiKeyFlow()),
      vscode.commands.registerCommand('vsh.hermes.chooseModel', () => void this.chooseModel()),
    );

    this.statusBar.connecting();
    this.log.appendLine(`VSHermes ${this.pluginVersion} activating… baseUrl=${getBaseUrl()}`);
    void this.connectAndSync();
  }

  private logInfo(msg: string): void {
    this.log.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  }

  private get pluginVersion(): string {
    return (this.context.extension.packageJSON.version as string) ?? '0.0.0';
  }

  // ── connection ────────────────────────────────────────────────────

  private async connectAndSync(): Promise<void> {
    try {
      const c = await this.ensureClient();
      this.health = await c.health();
      this.caps = await c.capabilities();
      this.statusBar.connected(this.health.version, this.caps.model);
      this.logInfo(`connected to Hermes ${this.health.version} at ${getBaseUrl()}`);
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
      this.view.post({ type: 'state', connected: false, baseUrl: getBaseUrl(), syncReport: null, sessionId: null, model: null, sessions: [], slashCommands: SLASH_COMMANDS, maxImageBytes: getMaxImageBytes(), maxImageDimension: getMaxImageDimension() });
      return;
    }
    await this.runSyncCheck(false);
    void this.listSessions();
    if (getCheckSyncOnStartup()) {
      this.view.postInfo(`Connected to Hermes ${this.health.version}. Type /help for commands.`);
    }
  }

  private async ensureClient(): Promise<HermesClient> {
    if (this.client) return this.client;
    const baseUrl = getBaseUrl();
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
      const res = await c.listSessions(200);
      this.history.refresh(res.data);
      this.view.post({ type: 'sessions', sessions: res.data });
      return res.data;
    } catch (err) {
      this.reportError(err);
      return [];
    }
  }

  private async newSession(): Promise<void> {
    this.abortStream();
    try {
      const c = await this.ensureClient();
      const res = await c.createSession();
      this.sessionId = res.session.id;
      this.activeRunId = null;
      this.view.post({ type: 'state', connected: true, baseUrl: getBaseUrl(), syncReport: this.syncReport, sessionId: this.sessionId, model: res.session.model, sessions: [], slashCommands: SLASH_COMMANDS, maxImageBytes: getMaxImageBytes(), maxImageDimension: getMaxImageDimension() });
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
      this.view.post({ type: 'messages', sessionId: id, messages: msgs.data });
      this.view.post({ type: 'state', connected: true, baseUrl: getBaseUrl(), syncReport: this.syncReport, sessionId: id, model: session?.session.model ?? null, sessions: [], slashCommands: SLASH_COMMANDS, maxImageBytes: getMaxImageBytes(), maxImageDimension: getMaxImageDimension() });
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
        this.view.post({ type: 'state', connected: true, baseUrl: getBaseUrl(), syncReport: this.syncReport, sessionId: null, model: null, sessions: [], slashCommands: SLASH_COMMANDS, maxImageBytes: getMaxImageBytes(), maxImageDimension: getMaxImageDimension() });
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
    // Image transfer strategy: text-only main models reject image_url parts
    // with 400, so file mode saves images to disk and references the path
    // (the agent's own vision fallback chain does the analysis).
    try {
      const mode = resolveImageMode(getImageTransferMode(), await this.modelVisionCaps());
      if (mode === 'file') {
        const home = resolveHermesEnv()?.homeDir ?? os.tmpdir();
        const attachDir = path.join(home, 'attachments');
        const { parts: transformed, written } = buildMessage(parts, mode, attachDir);
        if (written.length > 0) {
          this.logInfo(`image transfer (file mode) → ${written.join(', ')}`);
        }
        parts = transformed;
      }
    } catch (err) {
      this.logInfo(`image transfer planning failed, sending as-is: ${(err as Error).message}`);
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
      this.view.post({ type: 'messages', sessionId: sid, messages: msgs.data });
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
        this.view.post({
          type: 'state',
          connected: this.client !== null,
          baseUrl: getBaseUrl(),
          syncReport: this.syncReport,
          sessionId: this.sessionId,
          model: this.caps?.model ?? null,
          sessions: [],
          slashCommands: SLASH_COMMANDS,
          maxImageBytes: getMaxImageBytes(),
          maxImageDimension: getMaxImageDimension(),
        });
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
        await this.openSession(msg.id);
        break;
      case 'deleteSession':
        await this.deleteSession(msg.id);
        break;
      case 'forkSession':
        await this.forkSession();
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
