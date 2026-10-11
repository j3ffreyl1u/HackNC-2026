import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConfigError, loadAppConfig, loadEnvironmentFile, planLinkWarning } from '../../src/app/config.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('app config', () => {
  it('defaults to local mocks and disabled funding without requiring credentials', () => {
    const config = loadAppConfig({});
    expect(config).toMatchObject({
      chatMode: 'mock', researchMode: 'mock', calendarMode: 'manual', fundingMode: 'disabled',
      port: 3000,
    });
    expect(config.databasePath.endsWith('data\\trips.sqlite') || config.databasePath.endsWith('data/trips.sqlite')).toBe(true);
  });

  it('requires the matching credential set for explicitly selected live providers', () => {
    expect(() => loadAppConfig({ CHAT_MODE: 'photon' })).toThrow(/PROJECT_ID/);
    expect(() => loadAppConfig({ CHAT_MODE: 'photon', SPECTRUM_PROJECT_ID: 'project' })).toThrow(/SPECTRUM_PROJECT_SECRET/);
    expect(loadAppConfig({ RESEARCH_MODE: 'gemini', GEMINI_API_KEY: 'key' }).researchMode).toBe('gemini');
    expect(() => loadAppConfig({ CALENDAR_MODE: 'google' })).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => loadAppConfig({ FUNDING_MODE: 'nessie', NESSIE_API_KEY: 'key' })).toThrow(/NESSIE_BASE_URL/);
  });

  it('rejects invalid settings and never silently changes a selected mode', () => {
    expect(() => loadAppConfig({ RESEARCH_MODE: 'mock-after-failure' })).toThrow(AppConfigError);
    expect(() => loadAppConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadAppConfig({ FUNDING_MODE: 'nessie', NESSIE_API_KEY: 'key', NESSIE_BASE_URL: 'http://example.test' })).toThrow(/HTTPS/);
    expect(loadAppConfig({ RESEARCH_MODE: 'gemini', GEMINI_API_KEY: 'key', GEMINI_MODEL: 'configured-model' }).researchMode).toBe('gemini');
  });

  it('loads simple .env assignments without overriding shell values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trip-env-'));
    dirs.push(directory);
    const path = join(directory, '.env');
    await writeFile(path, 'PORT=4100\nCHAT_MODE="mock"\n# comment\n', 'utf8');
    const target = { CHAT_MODE: 'photon' } as NodeJS.ProcessEnv;
    await loadEnvironmentFile(path, target);
    expect(target).toMatchObject({ PORT: '4100', CHAT_MODE: 'photon' });
  });
});

describe('the trip-page link has to open on a phone', () => {
  it('warns when live chat has no public address, or one that is this computer', () => {
    expect(planLinkWarning('photon', undefined)).toMatch(/cloudflared|tunnel/i);
    expect(planLinkWarning('photon', '  ')).toMatch(/not set/);
    for (const local of ['http://127.0.0.1:3000', 'http://localhost:3000', 'https://localhost', 'http://0.0.0.0:3000', 'http://[::1]:3000']) expect(planLinkWarning('photon', local), local).toMatch(/this computer's own address/);
  });
  it('warns about a bad URL and about plain http, but accepts a tunnel address', () => {
    expect(planLinkWarning('photon', 'not a url')).toMatch(/not a valid URL/);
    expect(planLinkWarning('photon', 'http://example.com')).toMatch(/https/);
    expect(planLinkWarning('photon', 'https://quiet-fox-123.trycloudflare.com')).toBeUndefined();
  });
  it('says nothing in mock chat, where nobody opens the link on a phone', () => {
    expect(planLinkWarning('mock', undefined)).toBeUndefined();
  });
});
