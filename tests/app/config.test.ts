import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '../../src/app/config.js';

afterEach(() => vi.unstubAllEnvs());

describe('application configuration', () => {
  it('defaults to the local mock demo configuration', async () => {
    for (const name of ['BANK_MODE', 'CHAT_MODE', 'INTENT_MODE', 'HOUSEHOLD_CONFIG_PATH', 'DATABASE_PATH', 'PORT', 'DEMO_MODE']) {
      vi.stubEnv(name, '');
      delete process.env[name];
    }

    const config = await loadAppConfig();

    expect(config.databasePath).toBe('data/splitbot.sqlite');
    expect(config.port).toBe(3000);
    expect(config.demoMode).toBe(true);
    expect(config.household.householdId).toBe('demo-house');
    expect(config.household.demoCycles.map((cycle) => cycle.cycleId)).toEqual(['2026-10', '2026-11']);
  });

  it.each([
    ['BANK_MODE', 'nessie'],
    ['CHAT_MODE', 'photon'],
    ['INTENT_MODE', 'gemini'],
  ])('fails clearly when unsupported %s=%s is requested', async (name, mode) => {
    vi.stubEnv(name, mode);

    await expect(loadAppConfig()).rejects.toThrow(`${name}=${mode} is not wired in this build`);
  });

  it('rejects an invalid port and malformed demo mode', async () => {
    vi.stubEnv('PORT', '3000.5');
    await expect(loadAppConfig()).rejects.toThrow('PORT must be an integer');

    vi.stubEnv('PORT', '3000');
    vi.stubEnv('DEMO_MODE', 'sometimes');
    await expect(loadAppConfig()).rejects.toThrow('DEMO_MODE must be true or false');
  });
});
