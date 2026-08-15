/**
 * Pure formatting for session rows — no vscode imports, unit-testable.
 * Used by the History tree (and mirrored by the chat webview's own
 * token formatter, which cannot import host modules).
 */
import type { SessionSummary } from './api/types';

/** Compact token count: 1234 → "1.2k", 1234567 → "1.2M", 152000 → "152k" (no trailing .0). */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${n}`;
}

/** Compact cost: $0.0482 → "$0.05", $1.234 → "$1.23". */
export function fmtCost(usd: number | null | undefined): string {
  if (usd == null || !isFinite(usd)) return '';
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

/**
 * Token + cost summary for a session row, e.g. " · 152k tok · $0.05".
 * Empty when the session has no usage recorded (input 0 or null).
 */
export function sessionUsage(s: SessionSummary): string {
  const total = (s.input_tokens ?? 0) + (s.output_tokens ?? 0);
  if (total <= 0) return '';
  const cost = fmtCost(s.estimated_cost_usd);
  return ` · ${fmtTokens(total)} tok${cost ? ` · ${cost}` : ''}`;
}

/** Hover tooltip: id, preview, and the full token/cost breakdown when recorded. */
export function sessionTooltip(s: SessionSummary): string {
  const lines = [s.id, s.preview ?? ''].filter(Boolean);
  const hasTokens = (s.input_tokens ?? 0) > 0 || (s.output_tokens ?? 0) > 0;
  if (hasTokens) {
    lines.push(
      `${fmtTokens(s.input_tokens ?? 0)} in · ${fmtTokens(s.output_tokens ?? 0)} out` +
        `${s.cache_read_tokens ? ` · ${fmtTokens(s.cache_read_tokens)} cache` : ''}` +
        `${s.reasoning_tokens ? ` · ${fmtTokens(s.reasoning_tokens)} reasoning` : ''}` +
        (s.estimated_cost_usd ? ` · ${fmtCost(s.estimated_cost_usd)}` : ''),
    );
  }
  if (s.parent_session_id) lines.push(`continues from ${s.parent_session_id}`);
  return lines.join('\n');
}
