import { describe, expect, it } from 'vitest';
import { currentServerTarget, sessionTargetFromArg } from '../src/sessionArg';
import { LOCAL_ENDPOINT_ID } from '../src/endpointCore';

describe('sessionTargetFromArg', () => {
  it('maps a plain string to the current server', () => {
    expect(sessionTargetFromArg('api_123')).toEqual({ endpointId: null, sessionId: 'api_123' });
  });

  it('reads the { ep, sid } shape from history row clicks', () => {
    expect(sessionTargetFromArg({ ep: 'e1', sid: 'api_123' })).toEqual({
      endpointId: 'e1',
      sessionId: 'api_123',
    });
  });

  it('reads the TreeItem element shape (context-menu commands)', () => {
    const treeItem = { endpointId: 'e1', session: { id: 'api_123' } };
    expect(sessionTargetFromArg(treeItem)).toEqual({ endpointId: 'e1', sessionId: 'api_123' });
  });

  it('maps the Local endpoint id for local sections', () => {
    expect(sessionTargetFromArg({ ep: LOCAL_ENDPOINT_ID, sid: 'api_123' })).toEqual({
      endpointId: LOCAL_ENDPOINT_ID,
      sessionId: 'api_123',
    });
  });

  it('falls back to element .session.id / .id on the current server', () => {
    expect(sessionTargetFromArg({ session: { id: 'cli_999' } })).toEqual({ endpointId: null, sessionId: 'cli_999' });
    expect(sessionTargetFromArg({ id: 'cli_999' })).toEqual({ endpointId: null, sessionId: 'cli_999' });
  });

  it('returns undefined for garbage', () => {
    expect(sessionTargetFromArg(undefined)).toBeUndefined();
    expect(sessionTargetFromArg(null)).toBeUndefined();
    expect(sessionTargetFromArg(42)).toBeUndefined();
    expect(sessionTargetFromArg({})).toBeUndefined();
    expect(sessionTargetFromArg({ id: 42 })).toBeUndefined();
    expect(sessionTargetFromArg({ ep: 'e1' })).toBeUndefined();
    expect(sessionTargetFromArg({ sid: 'x' })).toBeUndefined();
  });
});

describe('currentServerTarget', () => {
  it('wraps an id with no endpoint switch', () => {
    expect(currentServerTarget('api_123')).toEqual({ endpointId: null, sessionId: 'api_123' });
  });
});
