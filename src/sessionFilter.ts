/**
 * Pure session filtering for the History tree — no vscode imports,
 * unit-testable.
 */
import type { SessionSummary } from './api/types';

const SOURCE_LABELS: Record<string, string> = {
  cli: 'terminal',
  api_server: 'vsh-hermes',
  gateway: 'gateway',
};

export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) =>
    [s.title, s.preview, s.id, s.model, SOURCE_LABELS[s.source ?? ''] ?? s.source ?? '']
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .some((v) => v.toLowerCase().includes(q)),
  );
}
