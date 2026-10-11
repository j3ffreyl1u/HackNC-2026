import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadDemoTrip, loadEnrolledTrip, enrollmentWarnings } from './fixture.js';
import { createChatAdapter } from './conversation-adapter.js';
import { createPlannerAdapter } from './planning-adapter.js';
import { createApplicationRuntime } from './runtime.js';
import { createResearchProvider } from '../research/provider.js';
import { createGeminiProvider, geminiConfigFromEnv } from '../research/gemini.js';
import { createLodgingLookup, createSerpApiHotels, serpApiConfigFromEnv } from '../research/serpapi.js';
import { createGeminiVoice } from '../conversation/voice.js';
import { demoResearchFixtures as defaultFixtures } from './research-fixtures.js';
import { LiveResearchDisplay, createLivePlanner } from './live-research.js';
import { loadAppConfig, loadEnvironmentFile, planLinkWarning } from './config.js';
import { createHttpServer } from './server.js';
import { SqliteTripRepository } from '../storage/sqlite-repository.js';
import { createNessieWriter, runDemoSequence, type DemoRun } from '../funding/demo-sequence.js';
import { createNessieReader } from '../funding/nessie-reader.js';
import { createFundService } from '../funding/service.js';

/** Real hotel prices (Google Hotels via SerpApi) when SERPAPI_API_KEY is set; otherwise lodging is priced the old way. */
function hotelLookup(timeZone: string | undefined) {
  const serp = serpApiConfigFromEnv(process.env);
  console.log(serp ? 'Hotel prices: Google Hotels via SerpApi (about one search per priced option).' : 'Hotel prices: SERPAPI_API_KEY not set, using web-search and typical lodging costs.');
  return serp ? { lookupLodging: createLodgingLookup(createSerpApiHotels(serp), timeZone) } : {};
}

export async function startApp(): Promise<() => Promise<void>> {
  await loadEnvironmentFile();
  const config = loadAppConfig();
  if (config.calendarMode !== 'manual') {
    throw new Error('Calendar extension is not integrated. Select manual calendar.');
  }
  const readJsonMap = async (path: string, what: string): Promise<Record<string, string>> => {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error(`${what} must be an ID-to-string object.`);
    return parsed as Record<string, string>;
  };
  const merchantCategories = config.fundingMode === 'nessie' && process.env.NESSIE_MERCHANTS_PATH ? await readJsonMap(process.env.NESSIE_MERCHANTS_PATH, 'Nessie merchant categories') : {};
  const accounts = config.fundingMode === 'nessie' ? await readJsonMap(process.env.NESSIE_ACCOUNTS_PATH!, 'Nessie accounts (trip member ID to account ID)') : {};
  const trip = config.chatMode === 'photon' ? await loadEnrolledTrip(config.tripConfigPath) : await loadDemoTrip(config.tripConfigPath);
  if (config.chatMode === 'photon') for (const warning of enrollmentWarnings(trip.enrollment)) console.warn(warning);
  if (config.chatMode === 'photon' && ((trip.enrollment.mode !== 'direct' && trip.enrollment.groupSpaceId.startsWith('mock-')) || trip.enrollment.participants.some(p => p.providerUserId.startsWith('mock-')))) throw new Error('Live chat needs a trip config with actual enrolled provider identities and, in group mode, the actual group space ID.');
  await mkdir(dirname(config.databasePath), { recursive: true });
  const repository = SqliteTripRepository.open(config.databasePath);
  const display = config.researchMode === 'gemini' ? new LiveResearchDisplay(process.env.GEMINI_API_KEY!, process.env.GEMINI_MODEL || 'gemini-3.8-flash', `http://127.0.0.1:${config.port}`) : undefined;
  const bankDemo = config.fundingMode === 'nessie' && process.env.DEMO_LEDGER === 'auto';
  // Demo only: "I just paid $60 for gas" posts a purchase to that person's own Nessie sandbox account (never real money).
  const logPurchases = config.fundingMode === 'nessie' && process.env.LOG_PURCHASES === 'on';
  const nessieReader = config.fundingMode === 'nessie' ? createNessieReader({ baseUrl: process.env.NESSIE_BASE_URL!, apiKey: process.env.NESSIE_API_KEY!, accounts, merchantCategories }) : undefined;
  const fundService = config.fundingMode === 'disabled' ? undefined : createFundService(nessieReader ?? { read: async () => ({ purchases: [] }) }, config.fundingMode, bankDemo || logPurchases ? { cacheMs: 0 } : {});
  const MERCHANT_FOR: Record<string, string> = { accommodation: 'hotel', fuel_parking_tolls: 'gas', food: 'restaurant', activities: 'parks', taxes_fees: 'fees', other: 'other' };
  const purchaseLogger = logPurchases ? {
    async log(memberId: string, category: string, dollars: number, what: string): Promise<string | undefined> {
      const writer = createNessieWriter({ baseUrl: process.env.NESSIE_BASE_URL!, apiKey: process.env.NESSIE_API_KEY! });
      const account = accounts[memberId];
      if (!account) throw new Error('No sandbox account for this person.');
      const merchantCategory = MERCHANT_FOR[category] ?? 'other';
      let merchant = Object.entries(merchantCategories).find(([, c]) => c === merchantCategory)?.[0];
      if (!merchant) {
        merchant = await writer.createMerchant(merchantCategory);
        merchantCategories[merchant] = merchantCategory;
        if (process.env.NESSIE_MERCHANTS_PATH) await writeFile(process.env.NESSIE_MERCHANTS_PATH, JSON.stringify(merchantCategories, null, 2));   // so a restart still knows what each merchant is
      }
      return writer.postPurchase(account, merchant, dollars, `SIMULATED trip purchase: ${what}`, new Date().toISOString().slice(0, 10));
    },
  } : undefined;
  // Demo only: after a plan is approved, walk through the bank accounts (see src/funding/demo-sequence.ts).
  const demoLedger = bankDemo && nessieReader ? (run: DemoRun) => runDemoSequence({ writer: createNessieWriter({ baseUrl: process.env.NESSIE_BASE_URL!, apiKey: process.env.NESSIE_API_KEY! }), reader: nessieReader, accounts, merchantCategories }, run) : undefined;
  const server = createHttpServer({ repository, researchDisplay: display, fundService });
  let runtime: ReturnType<typeof createApplicationRuntime> | undefined;
  try {
    await repository.bootstrapTrip(trip.enrollment, trip.state);
    const enrollment = (await repository.getEnrollment(trip.state.tripId))!;
    const stored = (await repository.loadTrip(enrollment.tripId))!;
    if (!stored.roster) await repository.commitEvent({ eventId: `roster-migration:${enrollment.tripId}`, expectedRevision: stored.revision, state: { ...stored, timeZone: trip.state.timeZone, roster: enrollment.participants.map(p => ({ memberId: p.memberId, displayName: p.displayName, consented: Boolean(p.consentedAt) })) }, messages: [] });
    const chat = await createChatAdapter(enrollment, trip.state.timeZone ?? 'America/New_York', config.chatMode);
    const planner = display ? createLivePlanner(display, enrollment.groupSpaceId)
      : config.researchMode === 'live' ? createPlannerAdapter(createResearchProvider({ mode: 'live', live: createGeminiProvider({ ...geminiConfigFromEnv(process.env)!, ...hotelLookup(trip.state.timeZone) }) }), enrollment.groupSpaceId)
      : createPlannerAdapter(createResearchProvider({ mode: 'mock', fixtures: defaultFixtures }), enrollment.groupSpaceId);
    const linkProblem = planLinkWarning(config.chatMode, process.env.PUBLIC_BASE_URL);
    if (linkProblem) console.warn(`WARNING: ${linkProblem}`);
    // Phones can only open the trip page if this is an address they can reach (set PUBLIC_BASE_URL to a tunnel or LAN address).
    const planUrl = `${(process.env.PUBLIC_BASE_URL?.trim() || `http://127.0.0.1:${config.port}`).replace(/\/+$/, '')}/?trip=${encodeURIComponent(enrollment.tripId)}`;
    const calendarUrl = `${(process.env.PUBLIC_BASE_URL?.trim() || `http://127.0.0.1:${config.port}`).replace(/\/+$/, '')}/api/trips/${encodeURIComponent(enrollment.tripId)}/plan.ics`;
    runtime = createApplicationRuntime({ repository, conversation: chat.conversation, planner, tripId: enrollment.tripId, fundService, ...(demoLedger ? { demoLedger } : {}), ...(purchaseLogger ? { purchaseLogger } : {}), planUrl, calendarUrl,
      ...(config.voiceMode === 'gemini' ? { voice: createGeminiVoice({ apiKey: process.env.GEMINI_API_KEY!, model: process.env.GEMINI_VOICE_MODEL || process.env.GEMINI_INTENT_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash', onError: () => console.error('Voice rewrite failed; sent the original text.') }) } : {}) });
    await runtime.start();
    const port = await server.listen(config.port);
    console.log(`Local trip plan page: http://127.0.0.1:${port}`);
    console.log(`Trip agent started: chat=${config.chatMode}, research=${config.researchMode}. Mock chat demo: npm run demo:chat`);
  } catch (error) {
    await runtime?.stop();
    repository.close();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return () => {
    if (!closing) {
      closing = Promise.all([server.close(), runtime?.stop()]).then(() => undefined).finally(() => repository.close());
    }
    return closing;
  };
}

async function run(): Promise<void> {
  const stop = await startApp();
  const shutdown = () => { void stop().finally(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void run().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Could not start the local trip planner.');
    process.exitCode = 1;
  });
}
