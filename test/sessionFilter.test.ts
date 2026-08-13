import { describe, expect, it } from 'vitest';
import { filterSessions } from '../src/sessionFilter';
import type { SessionSummary } from '../src/api/types';

const mk = (id: string, over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, title: null, preview: null, model: null, source: null, last_active: 0, ...over }) as unknown as SessionSummary;

describe('filterSessions', () => {
  it('returns everything for an empty query', () => {
    const s = [mk('a'), mk('b')];
    expect(filterSessions(s, '')).toHaveLength(2);
    expect(filterSessions(s, '   ')).toHaveLength(2);
  });

  it('matches title case-insensitively', () => {
    const s = [mk('a', { title: 'My Session' }), mk('b', { title: 'Other' })];
    expect(filterSessions(s, 'my session').map((x) => x.id)).toEqual(['a']);
  });

  it('matches id, model and source label', () => {
    const s = [mk('api_123', { model: 'deepseek-v4-flash' }), mk('api_456', { source: 'cli' })];
    expect(filterSessions(s, 'api_123').map((x) => x.id)).toEqual(['api_123']);
    expect(filterSessions(s, 'deepseek').map((x) => x.id)).toEqual(['api_123']);
    expect(filterSessions(s, 'terminal').map((x) => x.id)).toEqual(['api_456']);
  });

  it('matches preview text', () => {
    const s = [mk('a', { preview: 'checking the gateway logs' })];
    expect(filterSessions(s, 'gateway logs').map((x) => x.id)).toEqual(['a']);
  });
});
