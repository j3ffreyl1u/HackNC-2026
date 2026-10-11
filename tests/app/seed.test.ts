import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';

const root = process.cwd();
const seedCli = resolve('node_modules/tsx/dist/cli.mjs');
const seedScript = resolve('scripts/seed.ts');
const databaseFiles: string[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(databaseFiles.splice(0).flatMap((file) => [file, `${file}-wal`, `${file}-shm`].map((path) => rm(path, { force: true }))));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function seed(databasePath: string, reset = false) {
  return spawnSync(process.execPath, [seedCli, seedScript, ...(reset ? ['--reset'] : [])], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      CHAT_MODE: 'mock', RESEARCH_MODE: 'mock', CALENDAR_MODE: 'manual', FUNDING_MODE: 'disabled',
      TRIP_CONFIG_PATH: 'tests/fixtures/trip.json', DATABASE_PATH: databasePath,
    },
  });
}

describe('trip seed CLI', () => {
  it('is repeatable and reset rebuilds only the requested local trip database', async () => {
    await mkdir(resolve('data'), { recursive: true });
    const path = resolve('data', `travel-seed-${crypto.randomUUID()}.sqlite`);
    databaseFiles.push(path);

    const first = seed(path);
    expect(first.status, first.stderr).toBe(0);
    const second = seed(path);
    expect(second.status, second.stderr).toBe(0);

    const repository = SqliteTripRepository.open(path);
    const state = await repository.loadTrip('chapel-hill-weekend');
    expect(state?.revision).toBe(1);
    expect(state?.memberConstraints.filter((constraint) => constraint.field === 'budget').map((constraint) => constraint.value))
      .toEqual([20_000, 25_000, 30_000]);
    repository.close();

    const reset = seed(path, true);
    expect(reset.status, reset.stderr).toBe(0);
    const rebuilt = SqliteTripRepository.open(path);
    try {
      expect((await rebuilt.loadTrip('chapel-hill-weekend'))?.revision).toBe(1);
    } finally {
      rebuilt.close();
    }
  }, 45_000);

  it('refuses reset outside data and preserves the target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trip-seed-guard-'));
    tempDirectories.push(directory);
    const protectedPath = join(directory, 'keep.sqlite');
    await writeFile(protectedPath, 'keep this file', 'utf8');

    const result = seed(protectedPath, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--reset is limited');
    expect(await readFile(protectedPath, 'utf8')).toBe('keep this file');
  });
});
