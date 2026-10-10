import { readFile } from 'node:fs/promises';
import type { HouseholdConfig } from '../contracts/index.js';

export interface AppConfig { household: HouseholdConfig; databasePath: string; port: number; demoMode: boolean }
export async function loadAppConfig(): Promise<AppConfig> {
  for (const [name, fallback] of [['BANK_MODE', 'mock'], ['CHAT_MODE', 'mock'], ['INTENT_MODE', 'mock']] as const) {
    const value = process.env[name] ?? fallback;
    if (value !== 'mock') throw new Error(`${name}=${value} is not wired in this application build; use mock mode explicitly.`);
  }
  const configPath = process.env.HOUSEHOLD_CONFIG_PATH ?? 'tests/fixtures/household.json';
  const household = JSON.parse(await readFile(configPath, 'utf8')) as HouseholdConfig;
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const demoMode = (process.env.DEMO_MODE ?? 'true').toLowerCase() === 'true';
  if (!['true', 'false'].includes((process.env.DEMO_MODE ?? 'true').toLowerCase())) throw new Error('DEMO_MODE must be true or false');
  return { household, databasePath: process.env.DATABASE_PATH ?? 'data/splitbot.sqlite', port, demoMode };
}
