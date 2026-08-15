/**
 * Configuration + secret handling.
 *
 * The active endpoint profile (vsh.hermes.endpoints + activeEndpoint) wins
 * for both baseUrl and API key; without profiles the legacy resolution
 * applies. baseUrl comes from VS Code settings (vsh.hermes.baseUrl).
 * API keys live in SecretStorage — never in settings.json.
 * Key chain: active endpoint key → SecretStorage → VSHERMES_API_KEY env var
 * → Hermes .env (API_SERVER_KEY) → prompt flow.
 */

import * as vscode from 'vscode';
import { resolveHermesEnv } from './hermesEnv';
import { canonicalUrl, EndpointProfile, normalizeUrl } from './endpointCore';

const SECRET_KEY = 'vsh.hermes.apiKey';

function endpointSecretKey(id: string): string {
  return `vsh.hermes.apiKey.${id}`;
}

// ── endpoint profiles ─────────────────────────────────────────────

export function getEndpoints(): EndpointProfile[] {
  return vscode.workspace.getConfiguration('vsh.hermes').get<EndpointProfile[]>('endpoints', []);
}

export function getActiveEndpoint(): EndpointProfile | undefined {
  const id = vscode.workspace
    .getConfiguration('vsh.hermes')
    .get<string | null>('activeEndpoint', null);
  if (!id) return undefined;
  return getEndpoints().find((e) => e.id === id);
}

export async function saveEndpoints(endpoints: EndpointProfile[]): Promise<void> {
  await vscode.workspace
    .getConfiguration('vsh.hermes')
    .update('endpoints', endpoints, vscode.ConfigurationTarget.Global);
}

export async function setActiveEndpoint(id: string | null): Promise<void> {
  await vscode.workspace
    .getConfiguration('vsh.hermes')
    .update('activeEndpoint', id, vscode.ConfigurationTarget.Global);
}

export async function getEndpointApiKey(
  context: vscode.ExtensionContext,
  id: string,
): Promise<string | undefined> {
  return await context.secrets.get(endpointSecretKey(id));
}

export async function setEndpointApiKey(
  context: vscode.ExtensionContext,
  id: string,
  key: string,
): Promise<void> {
  await context.secrets.store(endpointSecretKey(id), key);
}

export async function clearEndpointApiKey(context: vscode.ExtensionContext, id: string): Promise<void> {
  await context.secrets.delete(endpointSecretKey(id));
}

// ── effective values ──────────────────────────────────────────────

/** The legacy (no-profile) resolution — what the built-in "Local
 *  connection" points at: explicit setting → Hermes .env → default. */
export function getLocalUrl(): string {
  const cfg = vscode.workspace.getConfiguration('vsh.hermes');
  const inspected = cfg.inspect<string>('baseUrl');
  const explicit = inspected?.globalValue ?? inspected?.workspaceValue;
  if (explicit && explicit.trim()) {
    return normalizeUrl(explicit) ?? explicit.trim();
  }
  const hermesEnv = resolveHermesEnv();
  if (hermesEnv) return hermesEnv.baseUrl;
  return 'http://127.0.0.1:8642';
}

/**
 * Effective API server base URL:
 * active endpoint profile → legacy resolution (getLocalUrl).
 */
export function getBaseUrl(): string {
  const active = getActiveEndpoint();
  if (active?.url) return active.url;
  return getLocalUrl();
}

/** Where the API key was found (for logging/diagnostics). */
export type KeySource = 'secret' | 'env-var' | 'hermes-env' | 'none';

export interface ApiKeyResult {
  key: string | undefined;
  source: KeySource;
}

/**
 * API key resolution chain:
 * active endpoint key → SecretStorage → VSHERMES_API_KEY env var
 * → Hermes .env (API_SERVER_KEY) → undefined (the caller may prompt).
 */
export async function getApiKey(context: vscode.ExtensionContext): Promise<ApiKeyResult> {
  const active = getActiveEndpoint();
  if (active) {
    const endpointKey = await getEndpointApiKey(context, active.id);
    if (endpointKey) return { key: endpointKey, source: 'secret' };
    // Two profiles may point at the same server — they share one credential
    // even though each has its own SecretStorage slot.
    const canonical = canonicalUrl(active.url);
    for (const ep of getEndpoints()) {
      if (ep.id !== active.id && canonicalUrl(ep.url) === canonical) {
        const shared = await getEndpointApiKey(context, ep.id);
        if (shared) return { key: shared, source: 'secret' };
      }
    }
  }
  const stored = await context.secrets.get(SECRET_KEY);
  if (stored) return { key: stored, source: 'secret' };
  const envKey = process.env.VSHERMES_API_KEY;
  if (envKey) return { key: envKey, source: 'env-var' };
  const hermesEnv = resolveHermesEnv();
  if (hermesEnv) return { key: hermesEnv.apiKey, source: 'hermes-env' };
  return { key: undefined, source: 'none' };
}

/**
 * Resolve the API key for an ARBITRARY endpoint (not just the active one):
 * its own SecretStorage slot → any profile sharing its URL → generic
 * SecretStorage key → env chain. Used by the activation guard, which must
 * judge the TARGET endpoint before it becomes active.
 */
export async function getKeyForEndpoint(
  context: vscode.ExtensionContext,
  endpoint: EndpointProfile | null,
  url: string,
): Promise<string | undefined> {
  if (endpoint) {
    const own = await getEndpointApiKey(context, endpoint.id);
    if (own) return own;
    const canonical = canonicalUrl(url);
    for (const ep of getEndpoints()) {
      if (ep.id !== endpoint.id && canonicalUrl(ep.url) === canonical) {
        const shared = await getEndpointApiKey(context, ep.id);
        if (shared) return shared;
      }
    }
  }
  const stored = await context.secrets.get(SECRET_KEY);
  if (stored) return stored;
  const envKey = process.env.VSHERMES_API_KEY;
  if (envKey) return envKey;
  return resolveHermesEnv()?.apiKey;
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

export type ImageTransferMode = 'auto' | 'inline' | 'file';

export function getImageTransferMode(): ImageTransferMode {
  return vscode.workspace.getConfiguration('vsh.hermes').get<ImageTransferMode>('imageTransfer', 'auto');
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
