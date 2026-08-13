/**
 * @file mention expansion — pure, unit-testable. The host supplies `resolve`
 * (mention → absolute path or null) and `read` (absolute path → content or
 * null); this module owns the syntax and the fencing.
 *
 * Syntax: `@file <path>` anywhere in the message text. Relative paths are
 * resolved by the host against the workspace; absolute paths pass through.
 * Unresolved mentions are left in place and reported, so the agent can still
 * see them rather than silently losing the reference.
 */

export const MAX_FILE_MENTION_BYTES = 100_000;

export interface FileMentionResult {
  /** Message text with resolved mentions replaced by fenced content. */
  text: string;
  /** Mentions that were inlined. */
  resolved: string[];
  /** Mentions that could not be resolved or were too large. */
  unresolved: string[];
}

const MENTION_RE = /@file\s+(\S+)/g;

/** Longest backtick run in the content + 1 → a fence that can't collide. */
function fenceFor(content: string): string {
  let run = 0;
  let max = 0;
  for (const ch of content) {
    if (ch === '`') {
      run += 1;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return '`'.repeat(Math.max(3, max + 1));
}

export function expandFileMentions(
  text: string,
  resolve: (mention: string) => string | null,
  read: (absPath: string) => string | null,
  maxBytes = MAX_FILE_MENTION_BYTES,
): FileMentionResult {
  if (!text.includes('@file')) return { text, resolved: [], unresolved: [] };
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const out = text.replace(MENTION_RE, (match, mention: string) => {
    const abs = resolve(mention);
    if (!abs) {
      unresolved.push(mention);
      return match;
    }
    const content = read(abs);
    if (content === null || content.length > maxBytes) {
      unresolved.push(mention);
      return match;
    }
    resolved.push(mention);
    const fence = fenceFor(content);
    return `${fence}${mention}\n${content}\n${fence}`;
  });
  return { text: out, resolved, unresolved };
}
