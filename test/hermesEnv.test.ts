import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { candidateHomes, parseEnvFile, resolveHermesEnv } from '../src/hermesEnv';

describe('parseEnvFile', () => {
  it('parses KEY=VALUE pairs, comments, export prefixes and quotes', () => {
    const vars = parseEnvFile(`# comment
API_SERVER_ENABLED=true
API_SERVER_KEY=my-secret-key-123
API_SERVER_HOST=0.0.0.0
export API_SERVER_PORT="8642"
EMPTY=
QUOTED='hello world'
`);
    expect(vars.API_SERVER_KEY).toBe('my-secret-key-123');
    expect(vars.API_SERVER_ENABLED).toBe('true');
    expect(vars.API_SERVER_HOST).toBe('0.0.0.0');
    expect(vars.API_SERVER_PORT).toBe('8642');
    expect(vars.EMPTY).toBe('');
    expect(vars.QUOTED).toBe('hello world');
  });

  it('handles CRLF and ignores malformed lines', () => {
    const vars = parseEnvFile('A=1\r\nB=2\r\nnot-a-var\r\n');
    expect(vars.A).toBe('1');
    expect(vars.B).toBe('2');
    expect(Object.keys(vars).length).toBe(2);
  });
});

describe('resolveHermesEnv', () => {
  const originalHome = process.env.HERMES_HOME;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsh-hermes-env-'));
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=from-temp-env-key-123\nAPI_SERVER_HOST=0.0.0.0\nAPI_SERVER_PORT=8642\n',
    );
  });

  afterAll(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves from $HERMES_HOME and normalizes 0.0.0.0 to 127.0.0.1', () => {
    process.env.HERMES_HOME = tmpDir;
    const cfg = resolveHermesEnv();
    expect(cfg).not.toBeNull();
    expect(cfg!.homeDir).toBe(tmpDir);
    expect(cfg!.apiKey).toBe('from-temp-env-key-123');
    expect(cfg!.baseUrl).toBe('http://127.0.0.1:8642');
  });

  it('returns null when no candidate has an API_SERVER_KEY', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsh-hermes-empty-'));
    fs.writeFileSync(path.join(emptyDir, '.env'), 'SOME_OTHER_KEY=abc\n');
    expect(resolveHermesEnv([emptyDir])).toBeNull();
  });

  it('skips a stale home without a key and uses the next candidate', () => {
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'vsh-hermes-stale-'));
    fs.writeFileSync(path.join(stale, '.env'), 'DEEPSEEK_API_KEY=abc\n');
    const cfg = resolveHermesEnv([stale, tmpDir]);
    expect(cfg!.homeDir).toBe(tmpDir);
  });

  it('candidate order prefers HERMES_HOME over the platform default', () => {
    const homes = candidateHomes();
    expect(homes[0]).toBe(tmpDir);
    expect(homes).toContain(path.join(os.homedir(), '.hermes'));
  });
});
