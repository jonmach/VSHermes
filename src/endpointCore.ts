/**
 * Endpoint profile core — pure helpers with no `vscode` import, so the
 * config layer, the Endpoints panel and the tests share one definition.
 *
 * An endpoint is a named Hermes API Server base URL. The active endpoint
 * drives getBaseUrl()/getApiKey(); non-loopback endpoints are "remote",
 * which disables file attach (no upload channel to the gateway).
 */

export interface EndpointProfile {
  /** Stable id — persisted in settings and used to scope SecretStorage keys. */
  id: string;
  /** Human-friendly name shown in the panel. */
  name: string;
  /** Hermes API Server base URL (e.g. http://192.168.1.20:8642). */
  url: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when the URL points at a non-loopback host (a different machine). */
export function isRemoteUrl(url: string): boolean {
  try {
    return !LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    // Unparseable → the connection will fail visibly on its own; don't
    // layer a restriction on top.
    return false;
  }
}

/** Trim + strip trailing slashes; empty input → null. */
export function normalizeUrl(url: string): string | null {
  const t = url.trim().replace(/\/+$/, '');
  return t.length > 0 ? t : null;
}

/** Sentinel endpoint id for the built-in "Local connection" (no profile). */
export const LOCAL_ENDPOINT_ID = 'local';

/** Canonical server key — collapses URL case/trailing-slash differences so
 *  two profiles pointing at the same server share one identity. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

/** Stable-ish id from a name (slug + timestamp + random suffix — two
 *  profiles created in the same millisecond must not collide, ids scope
 *  SecretStorage keys). */
export function makeEndpointId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slug || 'endpoint'}-${Date.now().toString(36)}${rand}`;
}

/** Display label for an endpoint id (used by the history tree + panel). */
export function endpointLabel(id: string | null, endpoints: EndpointProfile[]): string {
  if (id === null || id === LOCAL_ENDPOINT_ID) return 'Local';
  return endpoints.find((e) => e.id === id)?.name ?? id;
}
