/**
 * Status bar item: connection state + sync warning + active model.
 *
 *   $(plug)  Hermes v0.20.0 — deepseek-v4-flash     (connected)
 *   $(warning) VSHermes out of sync — check         (sync problem)
 *   $(circle-slash) Hermes offline                  (not reachable)
 */

import * as vscode from 'vscode';

export type ConnState = 'offline' | 'connecting' | 'connected' | 'sync-warning';

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = command;
    this.item.show();
  }

  private set(text: string, tooltip: string, icon: string, color?: string | vscode.ThemeColor) {
    this.item.text = `$(${icon}) ${text}`;
    this.item.tooltip = tooltip;
    this.item.color = color;
  }

  connecting(): void {
    this.set('Connecting to Hermes…', 'VSHermes — connecting to the Hermes API server', 'sync~spin');
  }

  connected(version: string | null, model: string | null): void {
    const v = version ? `v${version}` : '?';
    this.set(
      `Hermes ${v}${model ? ` — ${model}` : ''}`,
      `VSHermes — connected to Hermes ${v}. Click to open the chat view.`,
      'plug',
    );
  }

  offline(reason?: string): void {
    this.set(
      'Hermes offline',
      `VSHermes — cannot reach the Hermes API server${reason ? `: ${reason}` : ''}. Click to open the chat view.`,
      'circle-slash',
      new vscode.ThemeColor('charts.red'),
    );
  }

  syncWarning(summary: string): void {
    this.set('VSHermes out of sync', summary, 'warning', new vscode.ThemeColor('charts.yellow'));
  }

  dispose(): void {
    this.item.dispose();
  }
}
