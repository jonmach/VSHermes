/**
 * Hermes environment discovery — reads the API server configuration from
 * the existing Hermes installation instead of asking the user to re-enter it.
 *
 * Resolution order mirrors Hermes itself (hermes_constants.get_hermes_home):
 *   1. $HERMES_HOME env var
 *   2. /workspace/.hermes  (dev-container convention — the live home here)
 *   3. ~/.hermes           (platform default; may be a stale install)
 *
 * A candidate only counts as the live home if its .env parses AND contains
 * a usable API_SERVER_KEY — this prevents a stale ~/.hermes (old install
 * without the api_server platform) from shadowing the real config.
 *
 * Pure Node module — no 'vscode' import so it is unit-testable.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface HermesEnvConfig {
  /** Resolved Hermes home directory. */
  homeDir: string;
  /** The .env file the config came from. */
  envFile: string;
  /** API_SERVER_KEY — the bearer token for the API server platform. */
  apiKey: string;
  /** Effective base URL (0.0.0.0/:: hosts normalized to 127.0.0.1). */
  baseUrl: string;
  host: string;
  port: string;
}

/** Parse a dotenv-style file: KEY=VALUE, # comments, export prefix,
 * optional surrounding quotes. Values are NOT shell-expanded. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

export function candidateHomes(): string[] {
  const homes: string[] = [];
  const env = process.env.HERMES_HOME?.trim();
  if (env) homes.push(env);
  homes.push('/workspace/.hermes');
  homes.push(path.join(os.homedir(), '.hermes'));
  // De-duplicate while preserving order.
  return [...new Set(homes)];
}

function normalizeHost(host: string): string {
  const h = host.trim();
  if (!h || h === '0.0.0.0' || h === '::' || h === '[::]') return '127.0.0.1';
  return h.replace(/^\[|\]$/g, '');
}

/** Find the live Hermes home + API server config, or null.
 *  Candidates may be injected for testing; defaults to candidateHomes(). */
export function resolveHermesEnv(candidates?: string[]): HermesEnvConfig | null {
  for (const home of candidates ?? candidateHomes()) {
    const envFile = path.join(home, '.env');
    if (!fs.existsSync(envFile)) continue;
    let vars: Record<string, string>;
    try {
      vars = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
    } catch {
      continue;
    }
    const apiKey = vars.API_SERVER_KEY?.trim();
    if (!apiKey) continue; // no API server configured here — not the live home
    const host = vars.API_SERVER_HOST?.trim() || '127.0.0.1';
    const port = vars.API_SERVER_PORT?.trim() || '8642';
    return {
      homeDir: home,
      envFile,
      apiKey,
      baseUrl: `http://${normalizeHost(host)}:${port}`,
      host: normalizeHost(host),
      port,
    };
  }
  return null;
}
