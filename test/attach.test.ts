/**
 * Attach engine tests — run against the SHIPPED build (dist/attach.js),
 * same discipline as the webview suite. Verifies the copy semantics:
 * `@file <path>` → deterministic copy into attachments + token rewrite;
 * `@<path>` references untouched; idempotent re-expansion.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// tsc-emitted pure module (esbuild bundles the same source into
// dist/extension.js); emitted before tests run.
// @ts-expect-error — dist/src/attach.js exists after `npm run compile`
import { attachCopyPath, expandFileTokens } from '../dist/src/attach';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'vsh-attach-'));
}

describe('attach engine (dist/attach.js)', () => {
  it('names copies deterministically (basename + hash of source path)', () => {
    const a = attachCopyPath('/ws/docs/report.pdf', '/att');
    const b = attachCopyPath('/ws/docs/report.pdf', '/att');
    expect(a).toBe(b);
    expect(a).toContain('/att/report__');
    expect(a.endsWith('.pdf')).toBe(true);
    expect(attachCopyPath('/ws/docs/other.pdf', '/att')).not.toBe(a);
  });

  it('expands @file tokens: copies the file and rewrites the token', () => {
    const dir = tmp();
    const src = join(dir, 'report.pdf');
    writeFileSync(src, 'PDF BYTES');
    const attachDir = join(dir, 'attachments');
    const r = expandFileTokens(`see @file ${src}`, attachDir);
    expect(r.copied.length).toBe(1);
    expect(r.missing.length).toBe(0);
    expect(r.text).toBe(`see @file ${r.copied[0]}`);
    expect(existsSync(r.copied[0])).toBe(true);
    expect(readFileSync(r.copied[0], 'utf8')).toBe('PDF BYTES');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent: re-expanding does not copy again', () => {
    const dir = tmp();
    const src = join(dir, 'data.csv');
    writeFileSync(src, 'a,b,c');
    const attachDir = join(dir, 'attachments');
    const r1 = expandFileTokens(`@file ${src}`, attachDir);
    const r2 = expandFileTokens(`@file ${src}`, attachDir);
    expect(r2.copied.length).toBe(0);
    expect(r2.text).toBe(r1.text);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves plain @ references untouched; reports missing files', () => {
    const dir = tmp();
    const r = expandFileTokens('see @/opt/data and @file /nope.txt', dir);
    expect(r.text).toBe('see @/opt/data and @file /nope.txt');
    expect(r.copied.length).toBe(0);
    expect(r.missing).toEqual(['/nope.txt']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('handles paths with spaces (rest of the line is the path)', () => {
    const dir = tmp();
    const src = join(dir, 'my report.pdf');
    writeFileSync(src, 'x');
    const r = expandFileTokens(`@file ${src}`, join(dir, 'att'));
    expect(r.copied.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not re-copy a token that already points into attachments', () => {
    const dir = tmp();
    const attachDir = join(dir, 'attachments');
    const src = join(dir, 'a.txt');
    writeFileSync(src, 'hello');
    const r1 = expandFileTokens(`@file ${src}`, attachDir);
    const r2 = expandFileTokens(r1.text, attachDir);
    expect(r2.text).toBe(r1.text);
    expect(r2.copied.length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
