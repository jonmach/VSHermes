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
      padding: 8px;
    }
    #grid { display: flex; flex-direction: row; gap: 6px; flex-wrap: wrap; }
    .action {
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-editor-foreground, #ddd);
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px;
      width: 28px; height: 28px; padding: 0;
      font-family: inherit; font-size: 15px; line-height: 1;
      cursor: pointer; text-align: center;
      display: flex; align-items: center; justify-content: center;
    }
    .action:hover { border-color: var(--vscode-focusBorder, #3794ff); }
  </style>
</head>
<body>
  <div id="grid"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
