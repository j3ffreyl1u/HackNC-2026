import { mkdir, readFile } from 'node:fs/promises';
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
import { loadAppConfig, loadEnvironmentFile } from './config.js';
import { createHttpServer } from './server.js';
import { SqliteTripRepository } from '../storage/sqlite-repository.js';
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
  const merchantCategories = config.fundingMode === 'nessie' && process.env.NESSIE_MERCHANTS_PATH ? JSON.parse(await readFile(process.env.NESSIE_MERCHANTS_PATH, 'utf8')) as Record<string, string> : {};
  if (!merchantCategories || Array.isArray(merchantCategories) || typeof merchantCategories !== 'object' || Object.values(merchantCategories).some(value => typeof value !== 'string')) throw new Error('Nessie merchant categories must be an ID-to-string object.');
  const trip = config.chatMode === 'photon' ? await loadEnrolledTrip(config.tripConfigPath) : await loadDemoTrip(config.tripConfigPath);
  if (config.chatMode === 'photon') for (const warning of enrollmentWarnings(trip.enrollment)) console.warn(warning);
  if (config.chatMode === 'photon' && ((trip.enrollment.mode !== 'direct' && trip.enrollment.groupSpaceId.startsWith('mock-')) || trip.enrollment.participants.some(p => p.providerUserId.startsWith('mock-')))) throw new Error('Live chat needs a trip config with actual enrolled provider identities and, in group mode, the actual group space ID.');
  await mkdir(dirname(config.databasePath), { recursive: true });
  const repository = SqliteTripRepository.open(config.databasePath);
  const display = config.researchMode === 'gemini' ? new LiveResearchDisplay(process.env.GEMINI_API_KEY!, process.env.GEMINI_MODEL || 'gemini-3.8-flash', `http://127.0.0.1:${config.port}`) : undefined;
  const fundService = config.fundingMode === 'disabled' ? undefined : createFundService(config.fundingMode === 'nessie'
    ? createNessieReader({ baseUrl: process.env.NESSIE_BASE_URL!, apiKey: process.env.NESSIE_API_KEY!, accountId: process.env.NESSIE_ACCOUNT_ID!, merchantCategories })
    : { read: async () => ({ deposits: [], purchases: [] }) }, config.fundingMode, config.fundingMode === 'nessie' ? Number(process.env.NESSIE_PLAN_REVISION) : undefined);
  const server = createHttpServer({ repository, researchDisplay: display, fundService });
  let runtime: ReturnType<typeof createApplicationRuntime> | undefined;
  try {
    await repository.bootstrapTrip(trip.enrollment, trip.state);
    const enrollment = (await repository.getEnrollment(trip.state.tripId))!;
    const stored = (await repository.loadTrip(enrollment.tripId))!;
    if (!stored.roster) await repository.commitEvent({ eventId: `roster-migration:${enrollment.tripId}`, expectedRevision: stored.revision, state: { ...stored, timeZone: trip.state.timeZone, roster: enrollment.participants.map(p => ({ memberId: p.memberId, displayName: p.displayName, consented: Boolean(p.consentedAt) })) }, messages: [] });
    const chat = await createChatAdapter(enrollment, trip.state.timeZone ?? 'America/New_York', config.chatMode);
    const fundContext = fundService ? async (state: import('../contracts/index.js').TripState) => {
      const result = await fundService.inspect(state);
      return result.funding ? { remainingDollars: result.remainingDollars! } : undefined;
    } : undefined;
    const planner = display ? createLivePlanner(display, enrollment.groupSpaceId, { fundContext })
      : config.researchMode === 'live' ? createPlannerAdapter(createResearchProvider({ mode: 'live', live: createGeminiProvider({ ...geminiConfigFromEnv(process.env)!, ...hotelLookup(trip.state.timeZone) }) }), enrollment.groupSpaceId, { fundContext })
      : createPlannerAdapter(createResearchProvider({ mode: 'mock', fixtures: defaultFixtures }), enrollment.groupSpaceId, { fundContext });
    // Phones can only open the trip page if this is an address they can reach (set PUBLIC_BASE_URL to a tunnel or LAN address).
    const planUrl = `${(process.env.PUBLIC_BASE_URL?.trim() || `http://127.0.0.1:${config.port}`).replace(/\/+$/, '')}/?trip=${encodeURIComponent(enrollment.tripId)}`;
    const calendarUrl = `${(process.env.PUBLIC_BASE_URL?.trim() || `http://127.0.0.1:${config.port}`).replace(/\/+$/, '')}/api/trips/${encodeURIComponent(enrollment.tripId)}/plan.ics`;
    runtime = createApplicationRuntime({ repository, conversation: chat.conversation, planner, tripId: enrollment.tripId, fundService, planUrl, calendarUrl,
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
