/**
 * Configuration + secret handling.
 *
 * baseUrl comes from VS Code settings (vsh.hermes.baseUrl).
 * The API key lives in SecretStorage — never in settings.json.
 * Fallback chain: SecretStorage → VSHERMES_API_KEY env var → prompt flow.
 */

import * as vscode from 'vscode';

const SECRET_KEY = 'vsh.hermes.apiKey';

export function getBaseUrl(): string {
  const cfg = vscode.workspace.getConfiguration('vsh.hermes');
  const url = cfg.get<string>('baseUrl', 'http://127.0.0.1:8642').trim();
  return url.replace(/\/+$/, '');
}

export function getCheckSyncOnStartup(): boolean {
  return vscode.workspace.getConfiguration('vsh.hermes').get<boolean>('checkSyncOnStartup', true);
}

export function getMaxImageBytes(): number {
  return vscode.workspace.getConfiguration('vsh.hermes').get<number>('maxImageBytes', 8 * 1024 * 1024);
}

export function getMaxImageDimension(): number {
  return vscode.workspace.getConfiguration('vsh.hermes').get<number>('maxImageDimension', 4096);
}

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(SECRET_KEY);
  if (stored) return stored;
  const envKey = process.env.VSHERMES_API_KEY;
  if (envKey) return envKey;
  return undefined;
}

export async function setApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store(SECRET_KEY, key);
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
}

/** Interactive prompt flow — used when no key is configured yet. */
export async function promptForApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title: 'VSHermes — Hermes API Server key',
    prompt: 'Value of API_SERVER_KEY from your Hermes .env (gateway platform api_server).',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length >= 8 ? undefined : 'API key must be at least 8 characters'),
  });
  if (!input) return undefined;
  await setApiKey(context, input.trim());
  return input.trim();
}
