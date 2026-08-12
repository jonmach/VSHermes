import { describe, expect, it } from 'vitest';
import { sessionIdFromArg } from '../src/sessionArg';

describe('sessionIdFromArg', () => {
  it('passes a plain string through', () => {
    expect(sessionIdFromArg('api_123')).toBe('api_123');
  });

  it('extracts the id from a TreeItem element (view/item/context commands)', () => {
    // Context-menu commands receive the tree element, which carries .session.
    const treeItem = { id: 'api_123', session: { id: 'api_123' } };
    expect(sessionIdFromArg(treeItem)).toBe('api_123');
  });

  it('falls back to the element .id when .session is absent', () => {
    expect(sessionIdFromArg({ id: 'cli_999' })).toBe('cli_999');
  });

  it('returns undefined for garbage', () => {
    expect(sessionIdFromArg(undefined)).toBeUndefined();
    expect(sessionIdFromArg(null)).toBeUndefined();
    expect(sessionIdFromArg(42)).toBeUndefined();
    expect(sessionIdFromArg({})).toBeUndefined();
    expect(sessionIdFromArg({ id: 42 })).toBeUndefined();
  });
});
