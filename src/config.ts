/**
 * Configuration + secret handling.
 *
 * baseUrl comes from VS Code settings (vsh.hermes.baseUrl).
 * The API key lives in SecretStorage — never in settings.json.
 * Fallback chain: SecretStorage → VSHERMES_API_KEY env var → prompt flow.
 */

import * as vscode from 'vscode';
import { resolveHermesEnv } from './hermesEnv';

const SECRET_KEY = 'vsh.hermes.apiKey';

/**
 * Effective API server base URL:
 * explicit setting (vsh.hermes.baseUrl) → Hermes .env (API_SERVER_HOST:PORT)
 * → default http://127.0.0.1:8642.
 */
export function getBaseUrl(): string {
  const cfg = vscode.workspace.getConfiguration('vsh.hermes');
  const inspected = cfg.inspect<string>('baseUrl');
  const explicit = inspected?.globalValue ?? inspected?.workspaceValue;
  if (explicit && explicit.trim()) {
    return explicit.trim().replace(/\/+$/, '');
  }
  const hermesEnv = resolveHermesEnv();
  if (hermesEnv) return hermesEnv.baseUrl;
  return 'http://127.0.0.1:8642';
}

/** Where the API key was found (for logging/diagnostics). */
export type KeySource = 'secret' | 'env-var' | 'hermes-env' | 'none';

export interface ApiKeyResult {
  key: string | undefined;
  source: KeySource;
}

/**
 * API key resolution chain:
 * SecretStorage → VSHERMES_API_KEY env var → Hermes .env (API_SERVER_KEY)
 * → undefined (the caller may prompt).
 */
export async function getApiKey(context: vscode.ExtensionContext): Promise<ApiKeyResult> {
  const stored = await context.secrets.get(SECRET_KEY);
  if (stored) return { key: stored, source: 'secret' };
  const envKey = process.env.VSHERMES_API_KEY;
  if (envKey) return { key: envKey, source: 'env-var' };
  const hermesEnv = resolveHermesEnv();
  if (hermesEnv) return { key: hermesEnv.apiKey, source: 'hermes-env' };
  return { key: undefined, source: 'none' };
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
