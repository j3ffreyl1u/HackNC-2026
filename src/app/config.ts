import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type ChatMode = 'mock' | 'photon';
export type ResearchMode = 'mock' | 'gemini';
export type CalendarMode = 'manual' | 'google';
export type FundingMode = 'disabled' | 'mock' | 'nessie';

export interface AppConfig {
  chatMode: ChatMode;
  researchMode: ResearchMode;
  calendarMode: CalendarMode;
  fundingMode: FundingMode;
  databasePath: string;
  tripConfigPath: string;
  port: number;
}

export class AppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppConfigError';
  }
}

/** Load a small, single-line .env file without overriding values already supplied by the shell. */
export async function loadEnvironmentFile(path = '.env', target: NodeJS.ProcessEnv = process.env): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match || target[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    target[match[1]] = value;
  }
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const chatMode = choice(env.CHAT_MODE, ['mock', 'photon'] as const, 'mock', 'CHAT_MODE');
  const researchMode = choice(env.RESEARCH_MODE, ['mock', 'gemini'] as const, 'mock', 'RESEARCH_MODE');
  const calendarMode = choice(env.CALENDAR_MODE, ['manual', 'google'] as const, 'manual', 'CALENDAR_MODE');
  const fundingMode = choice(env.FUNDING_MODE, ['disabled', 'mock', 'nessie'] as const, 'disabled', 'FUNDING_MODE');
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new AppConfigError('PORT must be an integer from 1 to 65535.');

  if (chatMode === 'photon') {
    required(env.SPECTRUM_PROJECT_ID, 'SPECTRUM_PROJECT_ID');
    required(env.SPECTRUM_PROJECT_SECRET, 'SPECTRUM_PROJECT_SECRET');
  }
  if (researchMode === 'gemini') {
    required(env.GEMINI_API_KEY, 'GEMINI_API_KEY');
  }
  if (calendarMode === 'google') {
    required(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID');
    required(env.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET');
    required(env.GOOGLE_REFRESH_TOKEN, 'GOOGLE_REFRESH_TOKEN');
  }
  if (fundingMode === 'nessie') {
    required(env.NESSIE_API_KEY, 'NESSIE_API_KEY');
    required(env.NESSIE_BASE_URL, 'NESSIE_BASE_URL');
    let url: URL;
    try { url = new URL(env.NESSIE_BASE_URL); }
    catch { throw new AppConfigError('NESSIE_BASE_URL must be a valid HTTPS URL.'); }
    if (url.protocol !== 'https:') throw new AppConfigError('NESSIE_BASE_URL must use HTTPS.');
  }

  return {
    chatMode, researchMode, calendarMode, fundingMode,
    databasePath: resolve(env.DATABASE_PATH ?? 'data/trips.sqlite'),
    tripConfigPath: resolve(env.TRIP_CONFIG_PATH ?? 'tests/fixtures/trip.json'),
    port,
  };
}

function required(value: string | undefined, name: string): asserts value is string {
  if (!value?.trim()) throw new AppConfigError(`${name} is required for the selected live mode.`);
}

function choice<const T extends readonly string[]>(value: string | undefined, allowed: T, fallback: T[number], name: string): T[number] {
  const selected = value ?? fallback;
  if (!allowed.includes(selected)) throw new AppConfigError(`${name} must be one of: ${allowed.join(', ')}.`);
  return selected as T[number];
}
