#!/usr/bin/env node
/**
 * VSHermes standalone compatibility check — run outside VS Code:
 *
 *   node scripts/check-sync.mjs [--url http://127.0.0.1:8642] [--key <API_SERVER_KEY>]
 *
 * The key falls back to $VSHERMES_API_KEY, then $HERMES_HOME/.env, then
 * ~/.hermes/.env (API_SERVER_KEY). Prints the same verdict the plugin
 * shows in its status bar / banner. The script name is kept stable
 * (check-sync) for the same reason the command id stayed
 * vsh.hermes.checkSync — it is a handle, not a label.
 *
 * NOTE: this script mirrors the manifest in src/api/sync.ts. When the
 * manifest changes there, update REQUIRED_FEATURES/REQUIRED_ENDPOINTS here.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);
const PLUGIN_VERSION = PACKAGE.version;
const MIN_HERMES_VERSION = '0.20.0';
const REQUIRED_FEATURES = [
  'chat_completions', 'chat_completions_streaming', 'run_submission',
  'run_status', 'run_events_sse', 'run_stop', 'run_approval_response',
  'tool_progress_events', 'approval_events', 'session_chat',
  'session_chat_streaming', 'session_fork', 'session_model_lock',
  'model_options', 'skills_api',
];
const REQUIRED_ENDPOINTS = [
  'health', 'models', 'chat_completions', 'runs', 'run_status', 'run_events',
  'run_approval', 'run_stop', 'sessions', 'session_create', 'session',
  'session_update', 'session_delete', 'session_messages', 'session_fork',
  'session_chat', 'session_chat_stream', 'session_model_lock',
  'model_options', 'skills', 'toolsets',
];
const KNOWN_OPTIONAL = new Set([
  'admin_config_rw', 'jobs_admin', 'memory_write_api', 'audio_api',
  'realtime_voice', 'responses_api', 'responses_streaming',
  'session_resources', 'cors',
]);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function envKey() {
  const candidates = [
    process.env.HERMES_HOME ? join(process.env.HERMES_HOME, '.env') : null,
    join(homedir(), '.hermes', '.env'),
  ].filter((p) => p && existsSync(p));
  for (const p of candidates) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^API_SERVER_KEY=(.+)$/.exec(line.trim());
      if (m) return m[1];
    }
  }
  return undefined;
}

function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function main() {
  const baseUrl = (arg('--url') ?? process.env.VSHERMES_BASE_URL ?? 'http://127.0.0.1:8642').replace(/\/+$/, '');
  const key = arg('--key') ?? process.env.VSHERMES_API_KEY ?? envKey();

  if (!key) {
    console.error('No API key found. Pass --key <API_SERVER_KEY> or set VSHERMES_API_KEY.');
    process.exit(2);
  }

  let health, caps;
  try {
    const hres = await fetch(`${baseUrl}/health`);
    health = await hres.json();
    const cres = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!cres.ok) {
      console.error(`Capabilities fetch failed: ${cres.status} ${cres.statusText}`);
      process.exit(2);
    }
    caps = await cres.json();
  } catch (err) {
    console.error(`Cannot reach ${baseUrl}: ${err.message}`);
    process.exit(1);
  }

  const missingFeatures = REQUIRED_FEATURES.filter((f) => caps.features[f] === undefined || caps.features[f] === false);
  const missingEndpoints = REQUIRED_ENDPOINTS.filter((e) => !caps.endpoints[e]);
  const unknownFeatures = Object.entries(caps.features)
    .filter(([k, v]) => typeof v === 'boolean' && v === true && !KNOWN_OPTIONAL.has(k) && !REQUIRED_FEATURES.includes(k))
    .map(([k]) => k);
  const vc = compareVersions(health.version, MIN_HERMES_VERSION);
  const missingRequired = missingFeatures.length > 0 || missingEndpoints.length > 0;

  let status;
  if (missingRequired) status = 'OUTDATED';
  else if (vc === -1) status = 'UNTESTED';
  else if (unknownFeatures.length) status = 'AHEAD';
  else status = 'OK';

  console.log('VSHermes compatibility check');
  console.log('────────────────────────────');
  console.log(`plugin version : ${PLUGIN_VERSION}  (min verified Hermes ${MIN_HERMES_VERSION})`);
  console.log(`hermes version : ${health.version}`);
  console.log(`api server     : ${baseUrl}`);
  console.log(`verdict        : ${status}`);
  if (missingFeatures.length) {
    console.log(
      `  ! Hermes ${health.version} — ${missingFeatures.length} of ${REQUIRED_FEATURES.length} features VSHermes needs are unavailable: ${missingFeatures.join(', ')}`,
    );
  }
  if (missingEndpoints.length) {
    console.log(`  ! ${missingEndpoints.length} of ${REQUIRED_ENDPOINTS.length} required endpoints missing: ${missingEndpoints.join(', ')}`);
  }
  if (missingRequired) console.log(`  Upgrade Hermes to ${MIN_HERMES_VERSION}+.`);
  if (vc === -1 && !missingRequired) {
    console.log(`  ! Hermes ${health.version} is below the verified minimum ${MIN_HERMES_VERSION} — all required features are present, but this combination is untested.`);
  }
  if (unknownFeatures.length) {
    console.log(`  i Hermes advertises extra capabilities VSHermes does not use: ${unknownFeatures.join(', ')} — the plugin works normally.`);
  }
  if (status === 'OK') console.log(`  all VSHermes features are available on Hermes ${health.version}.`);
  process.exit(status === 'OUTDATED' ? 1 : 0);
}

main();
