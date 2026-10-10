import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConfigError, loadAppConfig, loadEnvironmentFile } from '../../src/app/config.js';

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
