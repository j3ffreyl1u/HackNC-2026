import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '../../src/app/config.js';

afterEach(() => vi.unstubAllEnvs());

describe('application configuration', () => {
  it('defaults to the local mock demo configuration', async () => {
    for (const name of ['BANK_MODE', 'CHAT_MODE', 'INTENT_MODE', 'HOUSEHOLD_CONFIG_PATH', 'DATABASE_PATH', 'PORT', 'DEMO_MODE', 'NESSIE_API_KEY', 'NESSIE_BASE_URL']) {
      vi.stubEnv(name, '');
      delete process.env[name];
    }

    const config = await loadAppConfig();

    expect(config.databasePath).toBe('data/splitbot.sqlite');
    expect(config.port).toBe(3000);
    expect(config.demoMode).toBe(true);
    expect(config.bankMode).toBe('mock');
    expect(config.household.householdId).toBe('demo-house');
    expect(config.household.demoCycles.map((cycle) => cycle.cycleId)).toEqual(['2026-10', '2026-11']);
  });

  it.each([
    ['CHAT_MODE', 'photon'],
    ['INTENT_MODE', 'gemini'],
  ])('fails clearly when unsupported %s=%s is requested', async (name, mode) => {
    vi.stubEnv(name, mode);
    await expect(loadAppConfig()).rejects.toThrow(`${name}=${mode} is not wired in this build`);
  });

  it('requires both Nessie credentials and selects Nessie without fallback', async () => {
    vi.stubEnv('BANK_MODE', 'nessie');
    await expect(loadAppConfig()).rejects.toThrow('NESSIE_API_KEY is required');

    vi.stubEnv('NESSIE_API_KEY', 'test-only-key');
    await expect(loadAppConfig()).rejects.toThrow('NESSIE_BASE_URL is required');

    vi.stubEnv('NESSIE_BASE_URL', 'https://sandbox.example.invalid');
    const config = await loadAppConfig();
    expect(config.bankMode).toBe('nessie');
    expect(config.nessieApiKey).toBe('test-only-key');
    expect(config.nessieBaseUrl).toBe('https://sandbox.example.invalid');
  });

  it('rejects unsupported bank modes, invalid ports, and malformed demo mode', async () => {
    vi.stubEnv('BANK_MODE', 'fallback');
    await expect(loadAppConfig()).rejects.toThrow('BANK_MODE=fallback is unsupported');

    vi.stubEnv('BANK_MODE', 'mock');
    vi.stubEnv('PORT', '3000.5');
    await expect(loadAppConfig()).rejects.toThrow('PORT must be an integer');

    vi.stubEnv('PORT', '3000');
    vi.stubEnv('DEMO_MODE', 'sometimes');
    await expect(loadAppConfig()).rejects.toThrow('DEMO_MODE must be true or false');
  });
});
