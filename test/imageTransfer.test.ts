import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildMessage, decodeDataUrl, resolveImageMode } from '../src/imageTransfer';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('resolveImageMode', () => {
  it('inline forces inline', () => {
    expect(resolveImageMode('inline', undefined)).toBe('inline');
  });
  it('file forces file', () => {
    expect(resolveImageMode('file', { vision: true })).toBe('file');
  });
  it('auto uses inline only when the model advertises vision', () => {
    expect(resolveImageMode('auto', { vision: true })).toBe('inline');
    expect(resolveImageMode('auto', { multimodal: true })).toBe('inline');
  });
  it('auto defaults to file without capability data (the common case)', () => {
    expect(resolveImageMode('auto', undefined)).toBe('file');
    expect(resolveImageMode('auto', {})).toBe('file');
  });
});

describe('decodeDataUrl', () => {
  it('decodes a base64 data URL with the right mime/extension', () => {
    const d = decodeDataUrl(`data:image/png;base64,${PNG_B64}`);
    expect(d).not.toBeNull();
    expect(d!.mime).toBe('image/png');
    expect(d!.ext).toBe('png');
    expect(d!.data.length).toBeGreaterThan(10);
  });
  it('returns null for non-data URLs', () => {
    expect(decodeDataUrl('https://example.com/x.png')).toBeNull();
  });
});

describe('buildMessage', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsh-imgtransfer-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('file mode writes the image to disk and replaces it with a text reference', () => {
    const { parts, written } = buildMessage(
      [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
        { type: 'text', text: 'What is in this screenshot?' },
      ],
      'file',
      tmpDir,
      1234567890,
    );
    expect(written.length).toBe(1);
    expect(fs.existsSync(written[0])).toBe(true);
    expect(written[0]).toContain('1234567890-0.png');
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('text');
    const text = (parts[0] as { text: string }).text;
    expect(text).toContain('[Image pasted:');
    expect(text).toContain(written[0]);
    expect(text).toContain('vision_analyze');
    expect(text).toContain('What is in this screenshot?');
  });

  it('file mode with an image only produces a reference without user text', () => {
    const { parts, written } = buildMessage(
      [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }],
      'file',
      tmpDir,
      999,
    );
    expect(written.length).toBe(1);
    expect(parts.length).toBe(1);
    expect((parts[0] as { text: string }).text).toContain('[Image pasted:');
  });

  it('file mode keeps text-only messages untouched', () => {
    const { parts, written } = buildMessage(
      [{ type: 'text', text: 'hello' }],
      'file',
      tmpDir,
    );
    expect(written.length).toBe(0);
    expect(parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('inline mode passes parts through untouched (no disk writes)', () => {
    const parts: Array<{ type: 'image_url'; image_url: { url: string } }> = [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ];
    const { parts: out, written } = buildMessage(parts, 'inline', tmpDir);
    expect(written.length).toBe(0);
    expect(out).toEqual(parts);
  });
});
