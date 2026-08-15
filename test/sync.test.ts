import { describe, expect, it } from 'vitest';
import { checkSync, compareVersions, MANIFEST } from '../src/api/sync';
import { MOCK_CAPABILITIES } from './mockServer';

const HEALTH = { status: 'ok', platform: 'hermes-agent', version: '0.20.0' };

function capsWith(overrides: { features?: Record<string, unknown>; endpoints?: Record<string, unknown> }): typeof MOCK_CAPABILITIES {
  return {
    ...MOCK_CAPABILITIES,
    features: { ...MOCK_CAPABILITIES.features, ...overrides.features },
    endpoints: { ...MOCK_CAPABILITIES.endpoints, ...overrides.endpoints },
  };
}

describe('compareVersions', () => {
  it('compares semver-ish versions', () => {
    expect(compareVersions('0.20.0', '0.20.0')).toBe(0);
    expect(compareVersions('0.19.0', '0.20.0')).toBe(-1);
    expect(compareVersions('0.20.1', '0.20.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.0')).toBe(1);
  });
});

describe('checkSync', () => {
  it('reports ok when aligned', () => {
    const r = checkSync(HEALTH, MOCK_CAPABILITIES, MANIFEST, '0.1.0');
    expect(r.status).toBe('ok');
    expect(r.missingRequiredFeatures).toEqual([]);
    expect(r.missingRequiredEndpoints).toEqual([]);
    expect(r.hermesVersion).toBe('0.20.0');
  });

  it('reports outdated when a required feature is missing', () => {
    const caps = capsWith({ features: { session_chat_streaming: false } });
    const r = checkSync(HEALTH, caps, MANIFEST, '0.1.0');
    expect(r.status).toBe('outdated');
    expect(r.missingRequiredFeatures).toContain('session_chat_streaming');
    expect(r.messages.join(' ')).toContain('1 of 15 features');
    expect(r.messages.join(' ')).toContain('Upgrade Hermes to');
  });

  it('describes missing features inline when few are missing', () => {
    const caps = capsWith({ features: { session_chat_streaming: false } });
    const r = checkSync(HEALTH, caps, MANIFEST, '0.1.0');
    expect(r.messages.join(' ')).toContain('session_chat_streaming (Streaming session chat)');
  });

  it('keeps the banner compact but lists descriptions for many missing features', () => {
    const caps = capsWith({
      features: Object.fromEntries(MANIFEST.requiredFeatures.slice(0, 6).map((f) => [f, false])),
    });
    const r = checkSync(HEALTH, caps, MANIFEST, '0.1.0');
    expect(r.status).toBe('outdated');
    // Banner line: bare names, no inline descriptions…
    expect(r.messages[0]).not.toContain('(');
    // …and a second message carries the described list for the tooltip.
    expect(r.messages[1]).toContain('Full list:');
    expect(r.messages[1]).toContain('(Streaming chat completions)');
  });

  it('reports outdated when a required endpoint is missing', () => {
    const caps = capsWith({ endpoints: { session_chat_stream: undefined } });
    const r = checkSync(HEALTH, caps, MANIFEST, '0.1.0');
    expect(r.status).toBe('outdated');
    expect(r.missingRequiredEndpoints).toContain('session_chat_stream');
  });

  it('reports untested when the version is below the minimum but nothing is missing', () => {
    const r = checkSync({ ...HEALTH, version: '0.18.0' }, MOCK_CAPABILITIES, MANIFEST, '0.1.0');
    expect(r.status).toBe('untested');
    expect(r.versionCompare).toBe(-1);
    expect(r.messages.join(' ')).toContain('all required features are present');
  });

  it('reports ahead when Hermes advertises unknown features', () => {
    const caps = capsWith({ features: { future_feature_x: true, future_feature_y: true } });
    const r = checkSync(HEALTH, caps, MANIFEST, '0.1.0');
    expect(r.status).toBe('ahead');
    expect(r.unknownFeatures).toEqual(['future_feature_x', 'future_feature_y']);
  });

  it('reports unknown when offline', () => {
    const r = checkSync(null, null, MANIFEST, '0.1.0');
    expect(r.status).toBe('unknown');
    expect(r.messages.length).toBeGreaterThan(0);
  });

  it('ignores optional features Hermes lacks (no false outdated)', () => {
    const caps = capsWith({ features: { admin_config_rw: false, audio_api: false, realtime_voice: false } });
    const r = checkSync(HEALTH, caps, MANIFEST, '0.1.0');
    expect(r.status).toBe('ok');
  });

  it('lists present optional features', () => {
    const caps = capsWith({ features: { responses_api: true } });
    const r = checkSync(HEALTH, caps, MANIFEST, '0.1.0');
    expect(r.presentOptionalFeatures).toContain('responses_api');
    expect(r.status).toBe('ok');
  });
});
