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
  | 'fork'
  | 'set-title'
  | 'status'
  | 'toolsets'
  | 'version'
  | 'reload'
  | 'doctor';

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: 'new', summary: 'Start a new chat session', kind: 'action', handler: 'new-session' },
  { name: 'clear', summary: 'Start a new chat session (alias of /new)', kind: 'action', handler: 'clear-session' },
  { name: 'model', summary: 'Switch the model for this session', args: '[model]', kind: 'action', handler: 'choose-model' },
  { name: 'stop', summary: 'Interrupt the running agent', kind: 'action', handler: 'stop' },
  { name: 'history', summary: 'Show session history', kind: 'action', handler: 'history' },
  { name: 'sessions', summary: 'Show session history', kind: 'action', handler: 'history' },
  { name: 'resume', summary: 'Show session history to continue a past session', kind: 'action', handler: 'history' },
  { name: 'title', summary: 'Set a title for the current session', args: '[name]', kind: 'action', handler: 'set-title' },
  { name: 'status', summary: 'Show current session info (id, title, model, messages)', kind: 'action', handler: 'status' },
  { name: 'skills', summary: 'List skills visible to Hermes', kind: 'action', handler: 'skills' },
  { name: 'fork', summary: 'Fork the current session', kind: 'action', handler: 'fork' },
  { name: 'branch', summary: 'Branch the current session (alias of /fork)', kind: 'action', handler: 'fork' },
  { name: 'help', summary: 'List available slash commands', kind: 'action', handler: 'help' },
  { name: 'toolsets', summary: 'List available toolsets', kind: 'action', handler: 'toolsets' },
  { name: 'version', summary: 'Show VSHermes and Hermes versions', kind: 'action', handler: 'version' },
  { name: 'reload', summary: 'Re-read the server config/.env and reconnect', kind: 'action', handler: 'reload' },
  { name: 'doctor', summary: 'Run a connection diagnostics check', kind: 'action', handler: 'doctor' },

  // Informational — sent to Hermes as normal text (no API equivalent).
  { name: 'compact', summary: 'Compress the conversation (sent as text; TUI command not available via API)', kind: 'informational' },
  { name: 'retry', summary: 'Retry the last turn (sent as text)', kind: 'informational' },
  { name: 'personality', summary: 'Switch personality (sent as text)', kind: 'informational' },
  { name: 'save', summary: 'Save the current conversation (sent as text)', kind: 'informational' },
  { name: 'compress', summary: 'Compress context manually (sent as text)', kind: 'informational' },
  { name: 'queue', summary: 'Queue a prompt for the next turn (sent as text)', kind: 'informational' },
  { name: 'steer', summary: 'Inject a mid-run note (sent as text)', kind: 'informational' },
  { name: 'goal', summary: 'Set a standing goal Hermes works toward (sent as text)', kind: 'informational' },
  { name: 'learn', summary: 'Distill a reusable skill from anything you describe (sent as text)', kind: 'informational' },

  // Unsupported — TUI-only (no API equivalent, NOT sent as text), or
  // already covered by a native VSHermes surface (see the summaries).
  { name: 'undo', summary: 'Undo last message (TUI-only)', kind: 'unsupported' },
  { name: 'yolo', summary: 'Bypass approval prompts (TUI-only)', kind: 'unsupported' },
  { name: 'export', summary: 'Export a profile (config, skills, theme) to a shareable archive (TUI-only)', kind: 'unsupported' },
  { name: 'memory', summary: 'Inspect memory files (TUI-only)', kind: 'unsupported' },
  { name: 'snapshot', summary: 'File checkpointing (TUI-only)', kind: 'unsupported' },
  { name: 'mcp', summary: 'Manage MCP servers (TUI-only)', kind: 'unsupported' },
  { name: 'plugins', summary: 'Manage plugins (TUI-only)', kind: 'unsupported' },
  { name: 'prompt', summary: 'Compose the next prompt in $EDITOR (TUI-only)', kind: 'unsupported' },
  { name: 'rollback', summary: 'List or restore filesystem checkpoints (TUI-only)', kind: 'unsupported' },
  { name: 'diff', summary: 'Show git changes in the working directory (TUI-only)', kind: 'unsupported' },
  { name: 'fast', summary: 'Toggle fast mode (TUI-only)', kind: 'unsupported' },
  { name: 'reasoning', summary: 'Manage reasoning effort/display (TUI-only)', kind: 'unsupported' },
  { name: 'voice', summary: 'Toggle CLI voice mode (TUI-only)', kind: 'unsupported' },
  { name: 'approvals', summary: 'Set dangerous-command approval mode (TUI-only)', kind: 'unsupported' },
  { name: 'tools', summary: 'Manage tools for the session (TUI-only)', kind: 'unsupported' },
  { name: 'browser', summary: 'Manage a local CDP browser connection (TUI-only)', kind: 'unsupported' },
  { name: 'bundles', summary: 'List configured skill bundles (TUI-only)', kind: 'unsupported' },
  { name: 'init', summary: 'Generate or update AGENTS.md (TUI-only)', kind: 'unsupported' },
  { name: 'cron', summary: 'Manage scheduled tasks (TUI-only)', kind: 'unsupported' },
  { name: 'whoami', summary: 'Show slash command access level (TUI-only)', kind: 'unsupported' },
  { name: 'usage', summary: 'Show token usage and cost (TUI-only)', kind: 'unsupported' },
  { name: 'update', summary: 'Update Hermes Agent (TUI-only)', kind: 'unsupported' },
  { name: 'paste', summary: 'Attach a clipboard image — paste into the chat input instead', kind: 'unsupported' },
  { name: 'image', summary: 'Attach an image — use the paperclip button or drag & drop instead', kind: 'unsupported' },
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
