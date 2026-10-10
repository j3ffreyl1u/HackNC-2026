import { readFile } from 'node:fs/promises';
import type { HouseholdConfig } from '../contracts/index.js';

export interface AppConfig {
  household: HouseholdConfig;
  databasePath: string;
  port: number;
  demoMode: boolean;
  bankMode: 'mock' | 'nessie';
  nessieApiKey?: string;
  nessieBaseUrl?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when BANK_MODE=nessie.`);
  return value;
}

export async function loadAppConfig(): Promise<AppConfig> {
  const bankMode = process.env.BANK_MODE ?? 'mock';
  if (bankMode !== 'mock' && bankMode !== 'nessie') throw new Error(`BANK_MODE=${bankMode} is unsupported; choose mock or nessie.`);
  for (const [name, fallback] of [['CHAT_MODE', 'mock'], ['INTENT_MODE', 'mock']] as const) {
    const value = process.env[name] ?? fallback;
    if (value !== 'mock') throw new Error(`${name}=${value} is not wired in this build; set it to mock explicitly.`);
  }
  const nessieApiKey = bankMode === 'nessie' ? requiredEnv('NESSIE_API_KEY') : undefined;
  const nessieBaseUrl = bankMode === 'nessie' ? requiredEnv('NESSIE_BASE_URL') : undefined;
  if (nessieBaseUrl) {
    let parsed: URL;
    try { parsed = new URL(nessieBaseUrl); }
    catch { throw new Error('NESSIE_BASE_URL must be a valid absolute URL.'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('NESSIE_BASE_URL must use HTTP or HTTPS.');
  }
  const configPath = process.env.HOUSEHOLD_CONFIG_PATH ?? 'tests/fixtures/household.json';
  const household = JSON.parse(await readFile(configPath, 'utf8')) as HouseholdConfig;
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const demoValue = (process.env.DEMO_MODE ?? 'true').toLowerCase();
  if (demoValue !== 'true' && demoValue !== 'false') throw new Error('DEMO_MODE must be true or false');
  return {
    household, databasePath: process.env.DATABASE_PATH ?? 'data/splitbot.sqlite', port,
    demoMode: demoValue === 'true', bankMode,
    ...(nessieApiKey ? { nessieApiKey } : {}), ...(nessieBaseUrl ? { nessieBaseUrl } : {}),
  };
}
