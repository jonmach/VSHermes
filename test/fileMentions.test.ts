import { describe, expect, it } from 'vitest';
import { expandFileMentions } from '../src/fileMentions';

describe('expandFileMentions', () => {
  const resolveMap: Record<string, string> = { 'src/foo.ts': '/ws/src/foo.ts' };
  const contents: Record<string, string> = { '/ws/src/foo.ts': 'export const x = 1;' };

  it('inlines a single mention as a fenced block', () => {
    const res = expandFileMentions(
      'Please review:\n@file src/foo.ts\nthanks',
      (m) => resolveMap[m] ?? null,
      (a) => contents[a] ?? null,
    );
    expect(res.resolved).toEqual(['src/foo.ts']);
    expect(res.unresolved).toEqual([]);
    expect(res.text).toContain('```src/foo.ts\nexport const x = 1;\n```');
    expect(res.text).not.toContain('@file');
  });

  it('handles multiple mentions in one message', () => {
    const res = expandFileMentions(
      '@file a.ts @file b.ts',
      (m) => (m === 'a.ts' ? '/a.ts' : m === 'b.ts' ? '/b.ts' : null),
      (a) => `content ${a}`,
    );
    expect(res.resolved).toHaveLength(2);
    expect(res.text).toContain('content /a.ts');
    expect(res.text).toContain('content /b.ts');
  });

  it('leaves unresolved mentions in place and lists them', () => {
    const res = expandFileMentions('@file missing.ts', () => null, () => null);
    expect(res.unresolved).toEqual(['missing.ts']);
    expect(res.resolved).toEqual([]);
    expect(res.text).toBe('@file missing.ts');
  });

  it('treats oversized content as unresolved', () => {
    const res = expandFileMentions('@file big.ts', (m) => '/big.ts', () => 'x'.repeat(1000), 100);
    expect(res.unresolved).toEqual(['big.ts']);
    expect(res.text).toBe('@file big.ts');
  });

  it('uses a longer fence when content contains backticks', () => {
    const res = expandFileMentions('@file md.md', (m) => '/md.md', () => '```\ncode\n```');
    expect(res.text).toContain('````md.md');
  });

  it('returns the text unchanged when there is no @file mention', () => {
    const res = expandFileMentions('just text', () => '/x', () => 'y');
    expect(res.text).toBe('just text');
    expect(res.resolved).toEqual([]);
    expect(res.unresolved).toEqual([]);
  });
});
