/**
 * Chat webview provider. Renders the VSHermes chat panel.
 * The webview is a thin client: all API traffic runs in the extension host
 * and is forwarded via the protocol in media/protocol.ts.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { HostMessage } from './media/protocol';
import { resolveHermesEnv } from '../hermesEnv';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  private readonly _onDidReceiveMessage = new vscode.EventEmitter<import('./media/protocol').WebviewMessage>();
  readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'dist', 'media')];
    const homeDir = resolveHermesEnv()?.homeDir;
    if (homeDir) roots.push(vscode.Uri.file(path.join(homeDir, 'attachments')));
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: roots,
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

  /** Tab label for the chat view (e.g. "Chat (Docker — remote)"). */
  setTitle(title: string): void {
    if (this.view) this.view.title = title;
  }

  /** Map an absolute local path to a webview-loadable URI, or null. */
  asImageUri(filePath: string): string | null {
    try {
      return this.view?.webview.asWebviewUri(vscode.Uri.file(filePath)).toString() ?? null;
    } catch {
      return null;
    }
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
    #sync-banner.ok { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #89d185) 12%, transparent); }
    #sync-banner .msg { flex: 1; white-space: pre-wrap; }
    #sync-banner button { background: none; border: 1px solid var(--vsh-border); color: var(--vsh-fg); border-radius: 3px; cursor: pointer; padding: 2px 8px; }
    #header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vsh-border); }
    #header .spacer { flex: 1; }
    #header button { background: none; border: none; color: var(--vsh-fg); cursor: pointer; font-size: 14px; padding: 2px 4px; border-radius: 3px; }
    #header button:hover { background: var(--vsh-user-bubble); }
    #conn { font-size: 11px; color: var(--vsh-muted); }
    #messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .msg { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
    .msg.user { align-items: flex-end; }
    .msg.assistant { align-items: flex-start; }
    .bubble-row { display: flex; align-items: flex-start; gap: 4px; max-width: 100%; }
    .bubble { padding: 8px 10px; border-radius: 8px; max-width: 92%; word-wrap: break-word; white-space: pre-wrap; }
    .msg.user .bubble { background: var(--vsh-user-bubble); border: 1px solid var(--vsh-border); }
    .msg.assistant .bubble { background: transparent; padding-left: 0; }
    .bubble :first-child { margin-top: 0; }
    .bubble :last-child { margin-bottom: 0; }
    .bubble p { margin: 0.4em 0; }
    .bubble pre { background: var(--vsh-code-bg); padding: 8px; border-radius: 6px; overflow-x: auto; position: relative; }
    .bubble code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .bubble pre code { background: none; padding: 0; }
    .copy-btn { position: absolute; top: 4px; right: 4px; background: var(--vsh-user-bubble); color: var(--vsh-fg); border: 1px solid var(--vsh-border); border-radius: 4px; font-size: 11px; padding: 1px 6px; cursor: pointer; opacity: 0.75; }
    .copy-btn:hover { opacity: 1; border-color: var(--vsh-accent); }
    .msg-copy { background: transparent; color: var(--vsh-muted); border: none; border-radius: 4px; font-size: 12px; padding: 2px 6px; cursor: pointer; opacity: 0; transition: opacity 0.15s; align-self: center; flex-shrink: 0; }
    .usage-line { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vsh-fg); background: var(--vsh-user-bubble); border: 1px solid var(--vsh-border); border-radius: 4px; padding: 1px 8px; margin-top: 4px; align-self: flex-start; user-select: none; }
    .msg:hover .msg-copy { opacity: 1; }
    .msg-copy:hover { color: var(--vsh-fg); background: var(--vsh-user-bubble); }
    .bubble img { max-width: 260px; border-radius: 6px; border: 1px solid var(--vsh-border); display: block; margin: 4px 0; }
    .msg.user .images { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .msg.user .images img { max-width: 120px; max-height: 120px; object-fit: cover; border-radius: 6px; border: 1px solid var(--vsh-border); }
    .tool-card { font-size: 12px; border: 1px solid var(--vsh-border); border-left: 3px solid var(--vsh-accent); border-radius: 6px; padding: 6px 10px; background: var(--vsh-user-bubble); max-width: 92%; position: relative; }
    .tool-card .tname { font-weight: 600; }
    .tool-card .tstatus { color: var(--vsh-muted); }
    .tool-card.failed { border-left-color: var(--vsh-error); }
    .tool-card.failed .tstatus { color: var(--vsh-error); }
    .tool-card pre { margin: 4px 0 0; font-size: 11px; white-space: pre-wrap; background: var(--vsh-code-bg); padding: 6px; border-radius: 4px; max-height: 160px; overflow-y: auto; }
    .tool-copy { position: absolute; top: 2px; right: 2px; background: transparent; color: var(--vsh-muted); border: none; border-radius: 4px; font-size: 12px; padding: 2px 6px; cursor: pointer; opacity: 0; transition: opacity 0.15s; }
    .tool-card:hover .tool-copy { opacity: 1; }
    .tool-copy:hover { color: var(--vsh-fg); background: var(--vsh-code-bg); }
    .thinking { font-size: 12px; color: var(--vsh-muted); border-left: 2px solid var(--vsh-border); padding-left: 8px; max-width: 92%; position: relative; }
    .thinking summary { cursor: pointer; }
    .thinking .body { white-space: pre-wrap; font-style: italic; }
    .thinking-copy { position: absolute; top: 0; right: 4px; background: transparent; color: var(--vsh-muted); border: none; border-radius: 4px; font-size: 12px; padding: 2px 6px; cursor: pointer; opacity: 0; transition: opacity 0.15s; }
    .thinking:hover .thinking-copy { opacity: 1; }
    .thinking-copy:hover { color: var(--vsh-fg); background: var(--vsh-user-bubble); }
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
    #attach-btn { background: none; border: none; color: var(--vsh-muted); padding: 7px 8px 8px; cursor: pointer; border-radius: 6px; line-height: 1; flex: none; }
    #attach-btn:hover { color: var(--vsh-fg); background: var(--vsh-border); }
    #attach-btn:disabled { opacity: 0.4; cursor: default; }
    #attach-btn:disabled:hover { color: var(--vsh-muted); background: none; }
    #input-area.dragover { outline: 2px dashed var(--vsh-accent); outline-offset: -4px; }
    #input { flex: 1; resize: none; background: var(--vsh-user-bubble); color: var(--vsh-fg); border: 1px solid var(--vsh-border); border-radius: 6px; padding: 8px; font-family: inherit; font-size: inherit; max-height: 180px; outline: none; overflow-wrap: anywhere; }
    #input:focus { border-color: var(--vsh-accent); }
    #send-btn { background: var(--vsh-accent); color: #fff; border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-weight: 600; }
    #send-btn:disabled { opacity: 0.5; cursor: default; }
    #slash-popup { position: absolute; bottom: 100%; left: 8px; right: 8px; max-height: 240px; overflow-y: auto; background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vsh-border); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.35); display: none; z-index: 10; }
    #slash-popup.show { display: block; }
    .slash-item { padding: 6px 10px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
    .slash-item.selected { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
    .slash-item .sname { font-weight: 600; }
    .slash-item .ssum { font-size: 11px; opacity: 0.85; }
    .slash-item .skind { margin-left: auto; font-size: 10px; opacity: 0.6; text-transform: uppercase; }
    #approval { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 20; align-items: center; justify-content: center; padding: 20px; }
    #approval.show { display: flex; }
    #approval .box { background: var(--vsh-bg); border: 1px solid var(--vsh-warn); border-radius: 8px; padding: 14px; max-width: 460px; width: 100%; max-height: 85vh; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
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
  </div>
  <div id="messages"></div>
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
      <button id="attach-btn" title="Attach file(s) — copied into the session attachments" aria-label="Attach file(s)"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 6v11.5a4 4 0 0 1-4 4 4 4 0 0 1-4-4V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V6a4 4 0 0 0-8 0v11.5a5.5 5.5 0 0 0 11 0V6h-1.5z"/></svg></button>
      <textarea id="input" rows="1" placeholder="Message Hermes… (drag files to attach)"></textarea>
      <button id="send-btn">&#10148;</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
