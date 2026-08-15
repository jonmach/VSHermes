/**
 * History row formatting: token/cost summaries and lineage markers.
 * Pure functions from historyProvider — no vscode dependency in the
 * helpers under test (importing the module pulls vscode, so these test
 * the helpers via the exported functions only; the TreeItem classes are
 * covered by the extension host at runtime).
 */
import { describe, expect, it } from 'vitest';
import { fmtCost, fmtTokens, sessionTooltip, sessionUsage } from '../src/sessionFormat';

describe('fmtTokens', () => {
  it('formats compact token counts', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1234)).toBe('1.2k');
    expect(fmtTokens(1500000)).toBe('1.5M');
    expect(fmtTokens(10000000)).toBe('10M');
  });
});

describe('fmtCost', () => {
  it('formats costs at the right precision', () => {
    expect(fmtCost(null)).toBe('');
    expect(fmtCost(undefined)).toBe('');
    expect(fmtCost(0.0482)).toBe('$0.048');
    expect(fmtCost(1.234)).toBe('$1.23');
    expect(fmtCost(150.5)).toBe('$151');
  });
});

describe('sessionUsage', () => {
  it('returns empty when no tokens recorded', () => {
    expect(sessionUsage({ input_tokens: 0, output_tokens: 0, estimated_cost_usd: null } as never)).toBe('');
  });

  it('returns tokens only when no cost recorded', () => {
    expect(sessionUsage({ input_tokens: 120000, output_tokens: 32000, estimated_cost_usd: null } as never)).toBe(' · 152k tok');
  });

  it('returns tokens and cost when both recorded', () => {
    expect(sessionUsage({ input_tokens: 120000, output_tokens: 32000, estimated_cost_usd: 0.0482 } as never)).toBe(' · 152k tok · $0.048');
  });
});

describe('sessionTooltip', () => {
  it('shows id, preview and full breakdown', () => {
    const tip = sessionTooltip({
      id: 's1',
      preview: 'hello',
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 2000,
      reasoning_tokens: 100,
      estimated_cost_usd: 0.01,
      parent_session_id: null,
    } as never);
    expect(tip).toContain('s1');
    expect(tip).toContain('hello');
    expect(tip).toContain('1k in · 500 out');
    expect(tip).toContain('2k cache');
    expect(tip).toContain('100 reasoning');
    expect(tip).toContain('$0.010');
  });

  it('notes the parent session when present', () => {
    const tip = sessionTooltip({ id: 'child', preview: null, parent_session_id: 'parent-1', input_tokens: 0, output_tokens: 0 } as never);
    expect(tip).toContain('continues from parent-1');
    expect(tip).not.toContain(' in · ');
  });
});
