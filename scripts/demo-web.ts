import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHttpServer } from '../src/app/server.js';
import { loadDemoTrip } from '../src/app/fixture.js';
import { runMockDemo } from '../src/app/mock-demo.js';
import { applyDemoStatus } from '../src/app/demo-state.js';
import { createFundService } from '../src/funding/service.js';
import type { Purchase } from '../src/planning/funding.js';
import { SqliteTripRepository } from '../src/storage/sqlite-repository.js';

/**
 * The trip page with realistic data and no keys, phone line or bank: the offline demo trip (approved, revision 12) plus a
 * clearly labelled SIMULATED ledger of what each friend paid. For working on the page. Not the real app.
 *
 *   npm run demo:web                 serves http://127.0.0.1:3000/?trip=chapel-hill-weekend
 *   PORT=3100 npm run demo:web       another port
 *   DEMO_LEDGER=empty|sample|uneven|even   which purchases the pretend banks report (default sample)
 *   DEMO_STATE=gathering|researching|proposed|awaiting_acceptance|approved   which stage the trip is in (default approved)
 *   DEMO_FUND=off                    fund panel hidden, as when tracking is disabled
 */
const LEDGERS: Record<string, Purchase[]> = {
  empty: [],
  sample: [
    { id: 'p1', memberId: 'mason', amountDollars: 110, category: 'hotel', status: 'completed' },
    { id: 'p2', memberId: 'alex', amountDollars: 60, category: 'gas', status: 'completed' },
    { id: 'p3', memberId: 'jordan', amountDollars: 30, category: 'parks', status: 'completed' },
    { id: 'p4', memberId: 'alex', amountDollars: 45, category: 'restaurant', status: 'completed' },
  ],
  uneven: [
    { id: 'p1', memberId: 'mason', amountDollars: 170, category: 'hotel', status: 'completed' },
    { id: 'p2', memberId: 'mason', amountDollars: 95, category: 'gas', status: 'completed' },
    { id: 'p3', memberId: 'mason', amountDollars: 120, category: 'parks', status: 'completed' },
    { id: 'p4', memberId: 'alex', amountDollars: 15, category: 'parking', status: 'completed' },
    { id: 'p5', memberId: 'jordan', amountDollars: 80, category: 'casino', status: 'completed' },
  ],
  even: [
    { id: 'p1', memberId: 'mason', amountDollars: 60, category: 'hotel', status: 'completed' },
    { id: 'p2', memberId: 'alex', amountDollars: 60, category: 'gas', status: 'completed' },
    { id: 'p3', memberId: 'jordan', amountDollars: 60, category: 'parks', status: 'completed' },
  ],
};

const ledgerName = process.env.DEMO_LEDGER ?? 'sample';
const purchases = LEDGERS[ledgerName];
if (!purchases) throw new Error(`DEMO_LEDGER must be one of ${Object.keys(LEDGERS).join(', ')}.`);
const stages = ['gathering', 'researching', 'proposed', 'awaiting_acceptance', 'approved'] as const;
const stage = (process.env.DEMO_STATE ?? 'approved') as (typeof stages)[number];
if (!stages.includes(stage)) throw new Error(`DEMO_STATE must be one of ${stages.join(', ')}.`);
const path = resolve(process.env.DATABASE_PATH || (stage === 'approved' ? 'data/web-demo.sqlite' : `data/web-demo-${stage}.sqlite`));
await mkdir(dirname(path), { recursive: true });
const repository = SqliteTripRepository.open(path);
const trip = await loadDemoTrip('tests/fixtures/trip.json');
if (!(await repository.loadTrip(trip.state.tripId))) {
  await runMockDemo(repository, trip.enrollment, trip.state, {});
  const finished = (await repository.loadTrip(trip.state.tripId))!;
  if (stage !== 'approved') await repository.saveTripIfRevision({ ...applyDemoStatus(finished, stage), revision: finished.revision + 1 }, finished.revision);
}
const fundService = process.env.DEMO_FUND === 'off' ? undefined : createFundService({ read: async () => ({ purchases }) }, 'mock', { cacheMs: 0 });
const server = createHttpServer({ repository, ...(fundService ? { fundService } : {}) });
const port = await server.listen(Number(process.env.PORT ?? 3000));
console.log(`Trip page (demo data, stage "${stage}", SIMULATED ledger "${ledgerName}"): http://127.0.0.1:${port}/?trip=${trip.state.tripId}`);
console.log('Ctrl+C to stop. Edit web/* and reload; the page polls every 5 seconds.');
const stop = () => { void server.close().finally(() => { repository.close(); process.exit(0); }); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
