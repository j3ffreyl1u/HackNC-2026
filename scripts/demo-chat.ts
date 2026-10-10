import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadDemoTrip } from '../src/app/fixture.js';
import { runMockDemo } from '../src/app/mock-demo.js';
import { SqliteTripRepository } from '../src/storage/sqlite-repository.js';

const path = resolve(process.env.DATABASE_PATH || 'data/chat-demo.sqlite');
await mkdir(dirname(path), { recursive: true });
const repository = SqliteTripRepository.open(path);
try {
  const trip = await loadDemoTrip('tests/fixtures/trip.json');
  const existing = await repository.loadTrip(trip.state.tripId);
  if (existing) {
    console.log(`Saved demo: revision ${existing.revision}, ${existing.status}. Use a new DATABASE_PATH to replay from scratch.`);
  } else {
    const result = await runMockDemo(repository, trip.enrollment, trip.state);
    for (const message of result.transcript) console.log(`[${message.audience.kind}] ${message.text}`);
    console.log(result.guide);
    console.log(`Demo completed: revision ${result.state.revision}, ${result.state.status}. Saved to ${path}`);
  }
} finally { repository.close(); }
