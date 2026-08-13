/**
 * Attach engine — `@file <path>` mentions.
 *
 * Semantics (settled design):
 *   - `@<path>`        — plain reference. Never touched: the LLM reads the
 *                        file or directory in place when it decides to.
 *   - `@file <path>`   — ATTACH: the file is copied into
 *                        $HERMES_HOME/attachments/ (the same place pasted
 *                        images land) and the token is rewritten to point at
 *                        the copy. The message stays small — one path per
 *                        file — and the LLM decides whether/when to load the
 *                        content, so nothing is ever inlined into the prompt.
 *
 * Copies are deterministic (basename + 8-hex hash of the source path), so
 * re-sending the same message never duplicates a copy, and a file that is
 * already an attachments copy is left untouched.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Deterministic copy target inside `attachDir` for `src`. */
export function attachCopyPath(src: string, attachDir: string): string {
  const base = path.basename(src);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const h = crypto.createHash('sha256').update(src).digest('hex').slice(0, 8);
  return path.join(attachDir, `${stem}__${h}${ext}`);
}

export interface FileTokenExpansion {
  /** Message text with `@file` tokens rewritten to their attachment copies. */
  text: string;
  /** Absolute paths of the copies written into attachments. */
  copied: string[];
  /** Source paths that could not be copied (missing) — left untouched. */
  missing: string[];
}

/** `@file <path>` mention: the token is the rest of the line (the picker
 *  rule — a mention is the final token on its line). */
const FILE_TOKEN = /@file\s+(\S.*)$/gm;

/** Expand every `@file <path>` mention in `text`: copy the file into
 *  `attachDir` (once) and point the token at the copy. Plain `@<path>`
 *  references and already-copied attachments are left untouched. */
export function expandFileTokens(text: string, attachDir: string): FileTokenExpansion {
  const copied: string[] = [];
  const missing: string[] = [];
  const out = text.replace(FILE_TOKEN, (m, srcRaw: string) => {
    const src = srcRaw.trim();
    // Already an attachments copy (or pointing into the attach dir)? Leave
    // untouched — re-hashing a copy path would duplicate it forever.
    if (path.resolve(path.dirname(src)) === path.resolve(attachDir)) return m;
    const target = attachCopyPath(src, attachDir);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      missing.push(src);
      return m;
    }
    if (!fs.existsSync(target)) {
      fs.mkdirSync(attachDir, { recursive: true });
      fs.copyFileSync(src, target);
      copied.push(target);
    }
    return `@file ${target}`;
  });
  return { text: out, copied, missing };
}
