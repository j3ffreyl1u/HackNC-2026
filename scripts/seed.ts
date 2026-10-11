import { mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadAppConfig, loadEnvironmentFile } from '../src/app/config.js';
import { loadDemoTrip } from '../src/app/fixture.js';
import { SqliteTripRepository } from '../src/storage/sqlite-repository.js';

async function main(): Promise<void> {
  await loadEnvironmentFile();
  const config = loadAppConfig();
  if (process.argv.includes('--reset')) {
    if (config.fundingMode !== 'disabled' && config.fundingMode !== 'mock') throw new Error('--reset is limited to local mock data.');
    const localData = resolve('data');
    const rel = relative(localData, config.databasePath);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('--reset is limited to a SQLite file inside the local data/ directory.');
    }
    await Promise.all([config.databasePath, `${config.databasePath}-wal`, `${config.databasePath}-shm`]
      .map((file) => rm(file, { force: true })));
  }

  const trip = await loadDemoTrip(config.tripConfigPath);
  await mkdir(dirname(config.databasePath), { recursive: true });
  const repository = SqliteTripRepository.open(config.databasePath);
  try {
    await repository.bootstrapTrip(trip.enrollment, trip.state);
    console.log(`Seeded mock trip ${trip.state.tripId} in ${config.databasePath}.`);
  } finally {
    repository.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Could not seed the local trip.');
  process.exitCode = 1;
});
