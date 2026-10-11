import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { loadEnvironmentFile } from '../src/app/config.js';
import { summarizeStoredConstraints } from '../src/app/diagnostics.js';
import type { TripState } from '../src/contracts/index.js';

await loadEnvironmentFile();
const argument = (flag: string) => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
const db = new Database(resolve(process.env.DATABASE_PATH ?? 'data/trips.sqlite'), { readonly: true, fileMustExist: true });
try {
  const tripId = argument('--trip');
  const rows = (tripId ? db.prepare('SELECT state_json FROM trips WHERE trip_id = ?').all(tripId) : db.prepare('SELECT state_json FROM trips').all()) as Array<{ state_json: string }>;
  if (!rows.length) throw new Error('No saved trip matches this database and trip ID.');
  const eventId = argument('--event');
  const eventProcessed = eventId ? Boolean(db.prepare('SELECT 1 FROM trip_events WHERE event_id = ?').get(eventId)) : undefined;
  console.log(JSON.stringify({ trips: rows.map(row => summarizeStoredConstraints(JSON.parse(row.state_json) as TripState)), ...(eventId ? { eventProcessed } : {}) }, null, 2));
} finally { db.close(); }
