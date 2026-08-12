/**
 * Home view provider — action hub tab (sits above Chat in the tab bar).
 * All traffic runs in the extension host; this webview only posts messages.
 */

import * as vscode from 'vscode';
import type { HostMessage } from './media/protocol';

export class HomeViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  private readonly _onDidReceiveMessage = new vscode.EventEmitter<import('./media/protocol').WebviewMessage>();
  readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'media')],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this._onDidReceiveMessage.fire(msg));
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  post(msg: HostMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  dispose(): void {
    this._onDidReceiveMessage.dispose();
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'media', 'home.js'),
    );
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `style-src 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: https:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VSHermes Home</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground, #ddd);
      padding: 12px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .status { font-size: 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--vscode-panel-border, #444); }
    .status.ok { color: var(--vscode-testing-iconPassed, #89d185); }
    .status.bad { color: var(--vscode-errorForeground, #f48771); }
    #grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .action {
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-editor-foreground, #ddd);
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px;
      padding: 10px 8px;
      font-family: inherit; font-size: 12px;
      cursor: pointer; text-align: center;
    }
    .action:hover { border-color: var(--vscode-focusBorder, #3794ff); }
    .note { font-size: 11px; color: var(--vscode-descriptionForeground, #9a9a9a); }
  </style>
</head>
<body>
  <div id="status" class="status">… connecting</div>
  <div id="grid"></div>
  <div class="note">New actions will appear here. Commands are also available from the command palette (VSHermes: …).</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
