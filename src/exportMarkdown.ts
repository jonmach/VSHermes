/**
 * Pure markdown serialization for session export — no vscode imports,
 * unit-testable. Used by the "VSHermes: Export Session as Markdown" command.
 */
import type { ChatMessage, SessionSummary } from './api/types';

export function messagesToMarkdown(
  messages: ChatMessage[],
  session?: SessionSummary | null,
): string {
  const out: string[] = [];
  out.push(`# ${session?.title ?? 'Hermes session'}`);
  out.push('');
  if (session) {
    out.push(`- Session: \`${session.id}\``);
    if (session.model) out.push(`- Model: ${session.model}`);
    if (session.started_at) out.push(`- Started: ${new Date(session.started_at).toLocaleString()}`);
    out.push('');
  }
  for (const m of messages) {
    if (m.role === 'user') {
      out.push('## User');
      out.push('');
      out.push(m.content ?? '');
      out.push('');
    } else if (m.role === 'assistant') {
      out.push('## Assistant');
      out.push('');
      const thinking = m.reasoning_content ?? m.reasoning ?? '';
      if (thinking) {
        out.push('> **Thinking**');
        out.push('>');
        for (const line of thinking.split('\n')) out.push(`> ${line}`);
        out.push('');
      }
      out.push(m.content ?? '');
      out.push('');
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          const t = tc as { name?: string; function?: { name?: string; arguments?: string } };
          const name = t.name ?? t.function?.name ?? 'tool';
          out.push(`_tool call: \`${name}\`_`);
        }
        out.push('');
      }
    }
  }
  return out.join('\n');
}
