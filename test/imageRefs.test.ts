import { describe, expect, it } from 'vitest';
import { enrichImageRefs } from '../src/imageRefs';

describe('enrichImageRefs', () => {
  it('replaces the full Image pasted reference with a markdown image', () => {
    const content =
      '[Image pasted: /tmp/att/1.png — if you need to see it, analyze it with vision_analyze.] plus text';
    const out = enrichImageRefs(content, (p) => `uri://${p}`);
    expect(out).toBe('![Image](uri:///tmp/att/1.png) plus text');
    expect(out).not.toContain('[Image pasted:');
    expect(out).not.toContain('vision_analyze');
  });

  it('leaves the text unchanged when the uri mapper returns null', () => {
    const content = '[Image pasted: /nope.png — gone]';
    expect(enrichImageRefs(content, () => null)).toBe(content);
  });

  it('returns null for null content', () => {
    expect(enrichImageRefs(null, () => 'x')).toBeNull();
  });

  it('handles multiple references', () => {
    const content = '[Image pasted: /a.png — one]\n[Image pasted: /b.png — two]';
    const out = enrichImageRefs(content, (p) => `u:${p}`);
    expect(out).toBe('![Image](u:/a.png)\n![Image](u:/b.png)');
  });
});
