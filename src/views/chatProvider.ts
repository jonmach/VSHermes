/**
 * Chat webview provider. Renders the VSHermes chat panel.
 * The webview is a thin client: all API traffic runs in the extension host
 * and is forwarded via the protocol in media/protocol.ts.
 */

import * as vscode from 'vscode';
import type { HostMessage } from './media/protocol';

export class ChatViewProvider implements vscode.WebviewViewProvider {
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

  postInfo(text: string): void {
    this.post({ type: 'info', text });
  }

  dispose(): void {
    this._onDidReceiveMessage.dispose();
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'media', 'chat.js'),
    );
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `style-src 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: https:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VSHermes</title>
  <style>
    :root {
      --vsh-border: var(--vscode-panel-border, #444);
      --vsh-bg: var(--vscode-editor-background, #1e1e1e);
      --vsh-fg: var(--vscode-editor-foreground, #ddd);
      --vsh-muted: var(--vscode-descriptionForeground, #9a9a9a);
      --vsh-accent: var(--vscode-focusBorder, #3794ff);
      --vsh-error: var(--vscode-errorForeground, #f48771);
      --vsh-warn: var(--vscode-editorWarning-foreground, #cca700);
      --vsh-user-bubble: var(--vscode-editorWidget-background, #252526);
      --vsh-code-bg: var(--vscode-textCodeBlock-background, #101014);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vsh-fg);
      background: var(--vsh-bg);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    #sync-banner { display: none; padding: 6px 10px; font-size: 12px; border-bottom: 1px solid var(--vsh-border); background: color-mix(in srgb, var(--vsh-warn) 12%, transparent); }
    #sync-banner.show { display: flex; gap: 8px; align-items: flex-start; }
    #sync-banner .msg { flex: 1; white-space: pre-wrap; }
    #sync-banner button { background: none; border: 1px solid var(--vsh-border); color: var(--vsh-fg); border-radius: 3px; cursor: pointer; padding: 2px 8px; }
    #header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vsh-border); }
    #header .model-badge { font-size: 11px; color: var(--vsh-muted); border: 1px solid var(--vsh-border); border-radius: 8px; padding: 1px 8px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
    #header .spacer { flex: 1; }
    #header button { background: none; border: none; color: var(--vsh-fg); cursor: pointer; font-size: 14px; padding: 2px 4px; border-radius: 3px; }
    #header button:hover { background: var(--vsh-user-bubble); }
    #conn { font-size: 11px; color: var(--vsh-muted); }
    #messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .msg { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
    .msg.user { align-items: flex-end; }
    .msg.assistant { align-items: flex-start; }
    .bubble { padding: 8px 10px; border-radius: 8px; max-width: 92%; word-wrap: break-word; white-space: pre-wrap; }
    .msg.user .bubble { background: var(--vsh-user-bubble); border: 1px solid var(--vsh-border); }
    .msg.assistant .bubble { background: transparent; padding-left: 0; }
    .bubble :first-child { margin-top: 0; }
    .bubble :last-child { margin-bottom: 0; }
    .bubble p { margin: 0.4em 0; }
    .bubble pre { background: var(--vsh-code-bg); padding: 8px; border-radius: 6px; overflow-x: auto; }
    .bubble code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .bubble pre code { background: none; padding: 0; }
    .bubble img { max-width: 260px; border-radius: 6px; border: 1px solid var(--vsh-border); display: block; margin: 4px 0; }
    .msg.user .images { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .msg.user .images img { max-width: 120px; max-height: 120px; object-fit: cover; border-radius: 6px; border: 1px solid var(--vsh-border); }
    .tool-card { font-size: 12px; border: 1px solid var(--vsh-border); border-left: 3px solid var(--vsh-accent); border-radius: 6px; padding: 6px 10px; background: var(--vsh-user-bubble); max-width: 92%; }
    .tool-card .tname { font-weight: 600; }
    .tool-card .tstatus { color: var(--vsh-muted); }
    .tool-card pre { margin: 4px 0 0; font-size: 11px; white-space: pre-wrap; background: var(--vsh-code-bg); padding: 6px; border-radius: 4px; max-height: 160px; overflow-y: auto; }
    .thinking { font-size: 12px; color: var(--vsh-muted); border-left: 2px solid var(--vsh-border); padding-left: 8px; max-width: 92%; }
    .thinking summary { cursor: pointer; }
    .thinking .body { white-space: pre-wrap; font-style: italic; }
    .meta { font-size: 11px; color: var(--vsh-muted); }
    .info-note { font-size: 12px; color: var(--vsh-muted); border: 1px dashed var(--vsh-border); border-radius: 6px; padding: 6px 10px; white-space: pre-wrap; }
    .error-note { font-size: 12px; color: var(--vsh-error); border: 1px solid var(--vsh-error); border-radius: 6px; padding: 6px 10px; white-space: pre-wrap; }
    #welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--vsh-muted); padding: 20px; text-align: center; }
    #welcome button { background: var(--vsh-accent); color: #fff; border: none; border-radius: 6px; padding: 6px 14px; cursor: pointer; }
    #welcome .sub { font-size: 12px; }
    #input-area { border-top: 1px solid var(--vsh-border); padding: 8px; display: flex; flex-direction: column; gap: 6px; position: relative; }
    #chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { position: relative; }
    .chip img { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; border: 1px solid var(--vsh-border); }
    .chip .x { position: absolute; top: -6px; right: -6px; background: var(--vsh-error); color: #fff; border: none; border-radius: 50%; width: 16px; height: 16px; font-size: 10px; line-height: 16px; cursor: pointer; text-align: center; }
    #input-row { display: flex; gap: 6px; align-items: flex-end; }
    #input { flex: 1; resize: none; background: var(--vsh-user-bubble); color: var(--vsh-fg); border: 1px solid var(--vsh-border); border-radius: 6px; padding: 8px; font-family: inherit; font-size: inherit; max-height: 180px; outline: none; }
    #input:focus { border-color: var(--vsh-accent); }
    #send-btn { background: var(--vsh-accent); color: #fff; border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-weight: 600; }
    #send-btn:disabled { opacity: 0.5; cursor: default; }
    #hint { font-size: 11px; color: var(--vsh-muted); }
    #slash-popup { position: absolute; bottom: 100%; left: 8px; right: 8px; max-height: 240px; overflow-y: auto; background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vsh-border); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.35); display: none; z-index: 10; }
    #slash-popup.show { display: block; }
    .slash-item { padding: 6px 10px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
    .slash-item.selected { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
    .slash-item .sname { font-weight: 600; }
    .slash-item .ssum { font-size: 11px; opacity: 0.85; }
    .slash-item .skind { margin-left: auto; font-size: 10px; opacity: 0.6; text-transform: uppercase; }
    #approval { display: none; position: absolute; inset: 0; background: rgba(0,0,0,0.45); z-index: 20; align-items: center; justify-content: center; padding: 20px; }
    #approval.show { display: flex; }
    #approval .box { background: var(--vsh-bg); border: 1px solid var(--vsh-warn); border-radius: 8px; padding: 14px; max-width: 460px; width: 100%; display: flex; flex-direction: column; gap: 10px; }
    #approval .box h3 { margin: 0; font-size: 13px; }
    #approval .cmd { background: var(--vsh-code-bg); padding: 8px; border-radius: 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }
    #approval .btns { display: flex; gap: 6px; flex-wrap: wrap; }
    #approval .btns button { flex: 1; min-width: 80px; padding: 6px; border-radius: 6px; border: 1px solid var(--vsh-border); background: var(--vsh-user-bubble); color: var(--vsh-fg); cursor: pointer; }
    #approval .btns button.deny { border-color: var(--vsh-error); color: var(--vsh-error); }
    #approval .btns button:hover { border-color: var(--vsh-accent); }
    .stop-btn { display: none; }
    .stop-btn.show { display: inline-block; background: var(--vsh-error); }
  </style>
</head>
<body>
  <div id="sync-banner"></div>
  <div id="header">
    <span id="conn"></span>
    <span class="spacer"></span>
    <span id="model-badge" class="model-badge" title="Switch model"></span>
    <button id="btn-history" title="History">&#9776;</button>
    <button id="btn-new" title="New chat">&#65291;</button>
  </div>
  <div id="messages"></div>
  <div id="welcome" hidden>
    <div style="font-size: 18px">&#9889; VSHermes</div>
    <div class="sub" id="welcome-sub">Connect to the Hermes API server to start chatting.</div>
    <div><button id="btn-welcome-new">New chat</button> <button id="btn-welcome-sync">Check sync</button></div>
  </div>
  <div id="input-area">
    <div id="slash-popup"></div>
    <div id="approval"><div class="box">
      <h3>&#9888;&#65039; Hermes needs approval</h3>
      <div class="cmd" id="approval-cmd"></div>
      <div class="btns">
        <button data-d="once">Allow once</button>
        <button data-d="session">Allow this session</button>
        <button data-d="always">Always allow</button>
        <button data-d="deny" class="deny">Deny</button>
      </div>
    </div></div>
    <div id="chips"></div>
    <div id="input-row">
      <textarea id="input" rows="1" placeholder="Message Hermes…  (/ for commands, paste images)"></textarea>
      <button id="send-btn">&#10148;</button>
    </div>
    <div id="hint">Enter to send &#183; Shift+Enter newline &#183; / commands &#183; paste or drop images</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
