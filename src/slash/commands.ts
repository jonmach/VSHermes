/**
 * Slash command catalog.
 *
 * The Hermes API Server does NOT interpret slash commands in message text —
 * it is an OpenAI-compatible surface. VSHermes therefore implements the
 * common commands client-side (mapped to API server endpoints) and lists
 * the rest as informational entries so the picker is honest about what is
 * available over the API surface. Commands that only exist in the TUI are
 * marked unsupported rather than silently sent as literal text.
 */

export type SlashKind = 'action' | 'informational' | 'unsupported';

export interface SlashCommandDef {
  name: string;
  summary: string;
  args?: string;
  kind: SlashKind;
  /** Host-side handler id (only for kind === 'action'). */
  handler?: SlashHandlerId;
}

export type SlashHandlerId =
  | 'new-session'
  | 'clear-session'
  | 'choose-model'
  | 'stop'
  | 'history'
  | 'skills'
  | 'help'
  | 'fork';

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: 'new', summary: 'Start a new chat session', kind: 'action', handler: 'new-session' },
  { name: 'clear', summary: 'Start a new chat session (alias of /new)', kind: 'action', handler: 'clear-session' },
  { name: 'model', summary: 'Switch the model for this session', args: '[model]', kind: 'action', handler: 'choose-model' },
  { name: 'stop', summary: 'Interrupt the running agent', kind: 'action', handler: 'stop' },
  { name: 'history', summary: 'Show session history', kind: 'action', handler: 'history' },
  { name: 'sessions', summary: 'Show session history', kind: 'action', handler: 'history' },
  { name: 'resume', summary: 'Show session history to continue a past session', kind: 'action', handler: 'history' },
  { name: 'skills', summary: 'List skills visible to Hermes', kind: 'action', handler: 'skills' },
  { name: 'fork', summary: 'Fork the current session', kind: 'action', handler: 'fork' },
  { name: 'help', summary: 'List available slash commands', kind: 'action', handler: 'help' },

  // Informational — sent to Hermes as normal text.
  { name: 'compact', summary: 'Compress the conversation (sent as text; TUI command not available via API)', kind: 'informational' },
  { name: 'retry', summary: 'Retry the last turn (sent as text)', kind: 'informational' },
  { name: 'personality', summary: 'Switch personality (sent as text)', kind: 'informational' },
  { name: 'prompt', summary: 'Show the active system prompt (sent as text)', kind: 'informational' },

  // Unsupported — TUI-only, no API equivalent, NOT sent as text.
  { name: 'undo', summary: 'Undo last message (TUI-only)', kind: 'unsupported' },
  { name: 'yolo', summary: 'Bypass approval prompts (TUI-only)', kind: 'unsupported' },
  { name: 'export', summary: 'Export conversation (TUI-only)', kind: 'unsupported' },
  { name: 'doctor', summary: 'Run diagnostics (TUI-only)', kind: 'unsupported' },
  { name: 'memory', summary: 'Inspect memory files (TUI-only)', kind: 'unsupported' },
  { name: 'snapshot', summary: 'File checkpointing (TUI-only)', kind: 'unsupported' },
  { name: 'mcp', summary: 'Manage MCP servers (TUI-only)', kind: 'unsupported' },
  { name: 'plugins', summary: 'Manage plugins (TUI-only)', kind: 'unsupported' },
];

export interface SlashMatch {
  /** Full input text. */
  input: string;
  /** Command name without the leading slash. */
  name: string;
  /** Arguments after the command name. */
  args: string;
  def?: SlashCommandDef;
}

/**
 * Match a leading /command in input. Only matches when the slash is at the
 * start of the input or after whitespace, and the command token is a plain
 * word (letters/digits/_/-).
 */
export function matchSlash(input: string): SlashMatch | null {
  const m = /(^|\s)\/([a-zA-Z][a-zA-Z0-9_-]*)(\s.*)?$/.exec(input.trimEnd());
  if (!m) return null;
  const name = m[2].toLowerCase();
  const args = (m[3] ?? '').trim();
  return {
    input,
    name,
    args,
    def: SLASH_COMMANDS.find((c) => c.name === name),
  };
}

export function filterSlash(query: string, limit = 8): SlashCommandDef[] {
  const q = query.toLowerCase();
  if (!q) return SLASH_COMMANDS.slice(0, limit);
  const scored = SLASH_COMMANDS.map((c) => {
    let score = -1;
    if (c.name.startsWith(q)) score = 100 - c.name.length;
    else if (c.name.includes(q)) score = 50 - c.name.length;
    else if (c.summary.toLowerCase().includes(q)) score = 10;
    return { c, score };
  })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.c);
}
