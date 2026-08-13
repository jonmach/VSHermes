import { describe, expect, it } from 'vitest';
import { messagesToMarkdown } from '../src/exportMarkdown';
import type { ChatMessage, SessionSummary } from '../src/api/types';

describe('messagesToMarkdown', () => {
  const session = {
    id: 'api_1',
    source: 'vsh-hermes',
    user_id: null,
    model: 'deepseek-v4-flash',
    title: 'My Session',
    started_at: 1723464000000,
    ended_at: null,
    end_reason: null,
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    api_call_count: 0,
    parent_session_id: null,
  } as unknown as SessionSummary;

  it('includes session metadata', () => {
    const md = messagesToMarkdown([], session);
    expect(md).toContain('# My Session');
    expect(md).toContain('api_1');
    expect(md).toContain('deepseek-v4-flash');
  });

  it('renders user and assistant messages in order', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ] as unknown as ChatMessage[];
    const md = messagesToMarkdown(msgs);
    expect(md.indexOf('## User')).toBeGreaterThan(-1);
    expect(md.indexOf('hello')).toBeLessThan(md.indexOf('hi there'));
    expect(md.indexOf('## Assistant')).toBeLessThan(md.indexOf('hi there'));
  });

  it('renders thinking as a blockquote and tool calls as footnotes', () => {
    const msgs = [
      {
        role: 'assistant',
        content: 'answer',
        reasoning_content: 'line one\nline two',
        tool_calls: [{ function: { name: 'terminal', arguments: '{"cmd":"ls"}' } }],
      },
    ] as unknown as ChatMessage[];
    const md = messagesToMarkdown(msgs);
    expect(md).toContain('> line one');
    expect(md).toContain('> line two');
    expect(md).toContain('tool call: `terminal`');
  });

  it('handles missing content and null session gracefully', () => {
    const md = messagesToMarkdown([{ role: 'user', content: null } as unknown as ChatMessage]);
    expect(md).toContain('# Hermes session');
    expect(md).toContain('## User');
  });
});
