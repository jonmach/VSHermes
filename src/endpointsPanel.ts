/**
 * VSHermes Endpoints panel — a dedicated webview panel, hidden by default,
 * toggled by the title-bar codicon / palette command. All logic (profile
 * store, keys, test) lives in the extension host; this class is view
 * plumbing + the HTML shell.
 */

import * as vscode from 'vscode';
import type { EndpointsHostMessage, EndpointsWebviewMessage } from './views/media/protocol';

export class EndpointsPanel {
  static readonly viewType = 'vsh.hermes.endpointsPanel';

  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidReceiveMessage = new vscode.EventEmitter<EndpointsWebviewMessage>();
  readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Show the panel, or hide (dispose) it when already visible. */
  toggle(): void {
    if (this.panel) {
      this.panel.dispose();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      EndpointsPanel.viewType,
      'VSHermes Endpoints',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'media')] },
    );
    this.panel = panel;
    panel.webview.html = this.renderHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => this._onDidReceiveMessage.fire(msg), null, this.disposables);
    panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      null,
      this.disposables,
    );
  }

  post(msg: EndpointsHostMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
    this._onDidReceiveMessage.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'media', 'endpoints.js'));
    // CSP mirrors the chat webview — cspSource in script-src is required
    // for the external (webview-origin) script to load in this VS Code.
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `style-src 'unsafe-inline'`,
    ].join('; ');
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root {
    --vsh-bg: var(--vscode-sideBar-background, #1e1e1e);
    --vsh-fg: var(--vscode-sideBar-foreground, #cccccc);
    --vsh-muted: var(--vscode-descriptionForeground, #9d9d9d);
    --vsh-border: var(--vscode-panel-border, #3c3c3c);
    --vsh-accent: var(--vscode-textLink-foreground, #3794ff);
    --vsh-warn: var(--vscode-editorWarning-foreground, #cca700);
    --vsh-error: var(--vscode-errorForeground, #f48771);
    --vsh-ok: #4ec9b0;
  }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vsh-fg); background: var(--vsh-bg); margin: 0; padding: 12px; }
  #status { font-size: 12px; color: var(--vsh-muted); margin-bottom: 12px; }
  #status.note { color: var(--vsh-warn); }
  .empty { color: var(--vsh-muted); padding: 8px 0; }
  .endpoint { border: 1px solid var(--vsh-border); border-radius: 6px; padding: 10px; margin-bottom: 10px; }
  .endpoint.active { border-color: var(--vsh-accent); }
  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .badges { display: flex; gap: 6px; }
  .badge { font-size: 10px; text-transform: uppercase; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--vsh-border); }
  .badge.remote { color: var(--vsh-warn); }
  .badge.local { color: var(--vsh-ok); }
  .badge.ok { color: var(--vsh-ok); }
  .badge.warn { color: var(--vsh-warn); }
  .fields { display: flex; gap: 6px; margin: 8px 0; }
  .fields input { flex: 1; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vsh-border); border-radius: 4px; padding: 4px 6px; }
  .keyrow { display: flex; gap: 6px; margin-bottom: 8px; }
  .keyrow input { flex: 1; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vsh-border); border-radius: 4px; padding: 4px 6px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  button { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  button.danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }
  .test-result { font-size: 11px; margin-top: 8px; }
  .test-result.ok { color: var(--vsh-ok); }
  .test-result.err { color: var(--vsh-error); }
  .add { display: flex; gap: 6px; margin-top: 14px; }
  .add input { flex: 1; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vsh-border); border-radius: 4px; padding: 5px 6px; }
  .hint { font-size: 11px; color: var(--vsh-muted); margin-top: 12px; line-height: 1.5; }
</style>
</head><body>
  <div id="status"></div>
  <div id="endpoint-list"></div>
  <div class="add">
    <input id="new-name" placeholder="Name (e.g. Home server)">
    <input id="new-url" placeholder="http://host:8642">
    <button id="add-btn">Add</button>
  </div>
  <div class="hint">Remote endpoints (non-loopback) disable file attach — the gateway can't receive files.
  API keys are stored per endpoint in VS Code SecretStorage. Use Test to check reachability.</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
