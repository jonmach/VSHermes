import { describe, expect, it } from 'vitest';
import { filterSlash, matchSlash, SLASH_COMMANDS } from '../src/slash/commands';

describe('matchSlash', () => {
  it('matches a leading slash command', () => {
    const m = matchSlash('/new');
    expect(m?.name).toBe('new');
    expect(m?.def?.kind).toBe('action');
  });

  it('matches with args', () => {
    const m = matchSlash('/model deepseek');
    expect(m?.name).toBe('model');
    expect(m?.args).toBe('deepseek');
  });

  it('matches after whitespace', () => {
    expect(matchSlash('hello /stop')?.name).toBe('stop');
  });

  it('does not match a mid-word slash', () => {
    expect(matchSlash('abc/def')).toBeNull();
  });

  it('returns null for unknown command but still parses the name', () => {
    const m = matchSlash('/nonexistent');
    expect(m?.name).toBe('nonexistent');
    expect(m?.def).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(matchSlash('/NEW')?.name).toBe('new');
  });
});

describe('filterSlash', () => {
  it('prefix match ranks first', () => {
    const r = filterSlash('new');
    expect(r[0].name).toBe('new');
  });

  it('substring match works', () => {
    const r = filterSlash('hist');
    expect(r[0].name).toBe('history');
  });

  it('empty query returns a limited list', () => {
    expect(filterSlash('').length).toBeLessThanOrEqual(8);
  });

  it('catalog marks TUI-only commands unsupported', () => {
    expect(SLASH_COMMANDS.find((c) => c.name === 'yolo')?.kind).toBe('unsupported');
    expect(SLASH_COMMANDS.find((c) => c.name === 'compact')?.kind).toBe('informational');
  });
});
