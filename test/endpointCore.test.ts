/**
 * Endpoint core tests — run against the tsc-emitted module
 * (dist/src/endpointCore.js, same source esbuild bundles into
 * dist/extension.js), same discipline as the attach engine tests.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — dist/src/endpointCore.js exists after `npm run compile`
import { isRemoteUrl, makeEndpointId, normalizeUrl } from '../dist/src/endpointCore';

describe('endpoint core (dist/src/endpointCore.js)', () => {
  it('treats loopback hosts as local', () => {
    expect(isRemoteUrl('http://127.0.0.1:8642')).toBe(false);
    expect(isRemoteUrl('http://localhost:8642')).toBe(false);
    expect(isRemoteUrl('http://[::1]:8642')).toBe(false);
    expect(isRemoteUrl('http://LOCALHOST:8642')).toBe(false);
  });

  it('treats anything else as remote', () => {
    expect(isRemoteUrl('http://192.168.1.20:8642')).toBe(true);
    expect(isRemoteUrl('https://hermes.example.com')).toBe(true);
    expect(isRemoteUrl('http://10.0.0.5:8642')).toBe(true);
  });

  it('is lenient on unparseable URLs (no restriction layered on top)', () => {
    expect(isRemoteUrl('not a url')).toBe(false);
    expect(isRemoteUrl('')).toBe(false);
  });

  it('normalizes URLs (trim + trailing slashes)', () => {
    expect(normalizeUrl('  http://host:8642/  ')).toBe('http://host:8642');
    expect(normalizeUrl('http://host:8642////')).toBe('http://host:8642');
    expect(normalizeUrl('   ')).toBeNull();
  });

  it('generates stable-ish unique ids', () => {
    const a = makeEndpointId('Home Server');
    const b = makeEndpointId('Home Server');
    expect(a).toMatch(/^home-server-/);
    expect(a).not.toBe(b); // timestamp suffix
    expect(makeEndpointId('!!!')).toMatch(/^endpoint-/);
  });
});
