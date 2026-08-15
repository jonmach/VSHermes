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

  it('catalog covers /title as a working action', () => {
    const title = SLASH_COMMANDS.find((c) => c.name === 'title');
    expect(title?.kind).toBe('action');
    expect(title?.handler).toBe('set-title');
    const m = matchSlash('/title My Session');
    expect(m?.name).toBe('title');
    expect(m?.args).toBe('My Session');
    expect(filterSlash('tit')[0].name).toBe('title');
  });

  it('syncs aliases and reclassifies /prompt honestly', () => {
    expect(SLASH_COMMANDS.find((c) => c.name === 'branch')?.handler).toBe('fork');
    expect(SLASH_COMMANDS.find((c) => c.name === 'status')?.kind).toBe('action');
    expect(SLASH_COMMANDS.find((c) => c.name === 'prompt')?.kind).toBe('unsupported');
  });

  it('promotes API-backed commands to working actions', () => {
    expect(SLASH_COMMANDS.find((c) => c.name === 'toolsets')?.kind).toBe('action');
    expect(SLASH_COMMANDS.find((c) => c.name === 'toolsets')?.handler).toBe('toolsets');
    expect(SLASH_COMMANDS.find((c) => c.name === 'version')?.handler).toBe('version');
    expect(SLASH_COMMANDS.find((c) => c.name === 'reload')?.handler).toBe('reload');
    expect(SLASH_COMMANDS.find((c) => c.name === 'doctor')?.handler).toBe('doctor');
  });

  it('reclassifies agent-workflow commands as informational (not sent to a dead end)', () => {
    expect(SLASH_COMMANDS.find((c) => c.name === 'goal')?.kind).toBe('informational');
    expect(SLASH_COMMANDS.find((c) => c.name === 'learn')?.kind).toBe('informational');
  });

  it('fixes the /export summary and drops the meaningless /quit', () => {
    const exp = SLASH_COMMANDS.find((c) => c.name === 'export');
    expect(exp?.kind).toBe('unsupported');
    expect(exp?.summary).toContain('profile');
    expect(SLASH_COMMANDS.find((c) => c.name === 'quit')).toBeUndefined();
  });

  it('points /paste and /image at the native attach surfaces', () => {
    expect(SLASH_COMMANDS.find((c) => c.name === 'paste')?.summary).toContain('paste into the chat input');
    expect(SLASH_COMMANDS.find((c) => c.name === 'image')?.summary).toContain('paperclip');
  });
});
