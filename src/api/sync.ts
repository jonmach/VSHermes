/**
 * VSHermes ↔ Hermes sync engine.
 *
 * The plugin ships with a pinned manifest of the Hermes API surface it was
 * built and verified against (features + endpoints + minimum version).
 * On connect it fetches GET /health (version) and GET /v1/capabilities
 * (self-described feature/endpoint surface) and diffs the two.
 *
 * Outcomes:
 *   ok       — aligned. Nothing to do.
 *   outdated — Hermes is OLDER than this plugin expects: a required feature
 *              or endpoint is missing, or the version is below the minimum.
 *              Action: upgrade Hermes (or downgrade the plugin).
 *   ahead    — Hermes is NEWER: it advertises features this plugin does not
 *              know about. Still functional; the plugin could surface them.
 *   unknown  — could not fetch health/capabilities (offline, bad key…).
 *
 * The report is shown as a banner in the chat view and as a warning in the
 * status bar, re-checkable on demand (command + button).
 */

import type { Capabilities, HealthStatus } from './types';

export interface SyncManifest {
  /** Lowest Hermes version this plugin was verified against. */
  minHermesVersion: string;
  /** Feature keys the plugin requires (from /v1/capabilities.features). */
  requiredFeatures: string[];
  /** Endpoint keys the plugin requires (from /v1/capabilities.endpoints). */
  requiredEndpoints: string[];
  /** Features the plugin knows about but treats as optional. */
  knownOptionalFeatures: Record<string, string>;
  /** Human descriptions for known required features. */
  featureDescriptions: Record<string, string>;
}

/** Pinned against Hermes 0.20.0 — every entry below was verified live. */
export const MANIFEST: SyncManifest = {
  minHermesVersion: '0.20.0',
  requiredFeatures: [
    'chat_completions',
    'chat_completions_streaming',
    'run_submission',
    'run_status',
    'run_events_sse',
    'run_stop',
    'run_approval_response',
    'tool_progress_events',
    'approval_events',
    'session_chat',
    'session_chat_streaming',
    'session_fork',
    'session_model_lock',
    'model_options',
    'skills_api',
  ],
  requiredEndpoints: [
    'health',
    'models',
    'chat_completions',
    'runs',
    'run_status',
    'run_events',
    'run_approval',
    'run_stop',
    'sessions',
    'session_create',
    'session',
    'session_update',
    'session_delete',
    'session_messages',
    'session_fork',
    'session_chat',
    'session_chat_stream',
    'session_model_lock',
    'model_options',
    'skills',
    'toolsets',
  ],
  knownOptionalFeatures: {
    admin_config_rw: 'Admin config editing (read/write)',
    jobs_admin: 'Cron/jobs administration',
    memory_write_api: 'Memory write API',
    audio_api: 'Audio / TTS API',
    realtime_voice: 'Realtime voice mode',
    responses_api: 'OpenAI Responses API',
    responses_streaming: 'Responses API streaming',
    session_resources: 'Session resources (per-session scoped context)',
    cors: 'CORS configuration',
  },
  featureDescriptions: {
    chat_completions: 'OpenAI-compatible chat completions',
    chat_completions_streaming: 'Streaming chat completions',
    run_submission: 'Agent run submission',
    run_events_sse: 'Run lifecycle events (SSE)',
    run_stop: 'Interrupt a running agent',
    run_approval_response: 'Resolve pending approvals',
    tool_progress_events: 'Live tool progress events',
    approval_events: 'Approval request events',
    session_chat: 'Chat with a persisted session',
    session_chat_streaming: 'Streaming session chat',
    session_fork: 'Session forking',
    session_model_lock: 'Per-session model lock',
    model_options: 'Model/options listing',
    skills_api: 'Skills listing',
  },
};

export type SyncStatus = 'ok' | 'outdated' | 'ahead' | 'unknown';

export interface SyncReport {
  status: SyncStatus;
  checkedAt: number;
  hermesVersion: string | null;
  pluginVersion: string;
  pluginMinVersion: string;
  /** -1 hermes older, 0 equal, 1 hermes newer (null if unknown). */
  versionCompare: -1 | 0 | 1 | null;
  missingRequiredFeatures: string[];
  missingRequiredEndpoints: string[];
  /** Hermes advertises features this plugin does not know at all. */
  unknownFeatures: string[];
  presentOptionalFeatures: string[];
  messages: string[];
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function checkSync(
  health: HealthStatus | null,
  caps: Capabilities | null,
  manifest: SyncManifest = MANIFEST,
  pluginVersion = '0.0.0',
): SyncReport {
  const report: SyncReport = {
    status: 'unknown',
    checkedAt: Date.now(),
    hermesVersion: health?.version ?? null,
    pluginVersion,
    pluginMinVersion: manifest.minHermesVersion,
    versionCompare: null,
    missingRequiredFeatures: [],
    missingRequiredEndpoints: [],
    unknownFeatures: [],
    presentOptionalFeatures: [],
    messages: [],
  };

  if (!health || !caps) {
    report.messages.push('Could not reach the Hermes API server to check sync.');
    return report;
  }

  report.versionCompare =
    report.hermesVersion !== null ? compareVersions(report.hermesVersion, manifest.minHermesVersion) : null;

  // Required features the Hermes side lacks.
  for (const feat of manifest.requiredFeatures) {
    const val = caps.features[feat];
    if (val === undefined || val === false) {
      report.missingRequiredFeatures.push(feat);
    }
  }

  // Required endpoints the Hermes side lacks.
  for (const ep of manifest.requiredEndpoints) {
    if (!caps.endpoints[ep]) {
      report.missingRequiredEndpoints.push(ep);
    }
  }

  // Features Hermes has that the plugin knows nothing about → plugin is behind.
  const known = new Set([...manifest.requiredFeatures, ...Object.keys(manifest.knownOptionalFeatures)]);
  for (const [key, val] of Object.entries(caps.features)) {
    if (typeof val === 'boolean' && val === true && !known.has(key)) {
      report.unknownFeatures.push(key);
    }
    if (typeof val === 'boolean' && val === true && manifest.knownOptionalFeatures[key]) {
      report.presentOptionalFeatures.push(key);
    }
  }

  // Decide status.
  const versionTooOld = report.versionCompare === -1;
  const missingRequired = report.missingRequiredFeatures.length > 0 || report.missingRequiredEndpoints.length > 0;

  if (missingRequired) {
    report.status = 'outdated';
  } else if (versionTooOld) {
    report.status = 'outdated';
  } else if (report.unknownFeatures.length > 0) {
    report.status = 'ahead';
  } else {
    report.status = 'ok';
  }

  // Human messages.
  if (missingRequired) {
    const feats = report.missingRequiredFeatures
      .map((f) => `${f}${manifest.featureDescriptions[f] ? ` (${manifest.featureDescriptions[f]})` : ''}`)
      .join(', ');
    const eps = report.missingRequiredEndpoints.join(', ');
    report.messages.push(
      `This Hermes is missing capabilities the plugin requires${
        feats ? ` — features: ${feats}` : ''
      }${eps ? ` — endpoints: ${eps}` : ''}. Upgrade Hermes or install an older VSHermes release.`,
    );
  } else if (versionTooOld) {
    report.messages.push(
      `Hermes ${report.hermesVersion} is older than the minimum verified version ${manifest.minHermesVersion}. Upgrade Hermes for the full plugin surface.`,
    );
  }
  if (report.status === 'ahead') {
    report.messages.push(
      `Hermes advertises capabilities this plugin does not know about yet: ${report.unknownFeatures.join(', ')}. ` +
        `The plugin still works — a newer VSHermes may surface them.`,
    );
  }
  if (report.status === 'ok' && report.hermesVersion) {
    report.messages.push(`Aligned with Hermes ${report.hermesVersion}.`);
  }

  return report;
}
