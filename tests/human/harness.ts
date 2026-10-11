import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatAdapter } from '../../src/app/conversation-adapter.js';
import { loadEnrolledTrip } from '../../src/app/fixture.js';
import { createPlannerAdapter } from '../../src/app/planning-adapter.js';
import { demoResearchFixtures } from '../../src/app/research-fixtures.js';
import { createApplicationRuntime } from '../../src/app/runtime.js';
import { MockMessenger } from '../../src/conversation/index.js';
import { dmEvent } from '../../src/conversation/mock.js';
import { createFundService } from '../../src/funding/service.js';
import type { FundLedger } from '../../src/funding/nessie-reader.js';
import { createResearchProvider } from '../../src/research/provider.js';
import { SqliteTripRepository } from '../../src/storage/sqlite-repository.js';

export const PHONES = { mason: '+15550000001', alex: '+15550000002', jordan: '+15550000003' } as const;
export type Who = keyof typeof PHONES;
const dirs: string[] = [];
export const cleanup = () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); };

export interface Heard { mason: string[]; alex: string[]; jordan: string[]; all: string[] }

/** Three real people texting the real parser + runtime + planner over a mock phone line (direct mode). */
export async function humans(opts: { names?: Partial<Record<Who, string>>; start?: string; provider?: ReturnType<typeof createResearchProvider>; fund?: 'mock' | 'broken'; fundService?: ReturnType<typeof createFundService> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'human-')); dirs.push(dir);
  const path = join(dir, 'trip.json');
  const names = { mason: 'Mason', alex: 'Alex', jordan: 'Jordan', ...opts.names };
  writeFileSync(path, JSON.stringify({ mode: 'direct', tripId: 'h', groupSpaceId: 'direct:h', timeZone: 'America/New_York',
    participants: (Object.keys(PHONES) as Who[]).map((w) => ({ memberId: w, displayName: names[w], providerUserId: PHONES[w], consentedAt: '2026-10-10T12:00:00Z' })) }));
  const trip = await loadEnrolledTrip(path);
  const repository = SqliteTripRepository.open(join(dir, 'trips.sqlite'));
  await repository.bootstrapTrip(trip.enrollment, trip.state);
  const messenger = new MockMessenger();
  const chat = await createChatAdapter(trip.enrollment, 'America/New_York', 'mock', process.env, messenger);
  const planner = createPlannerAdapter(opts.provider ?? createResearchProvider({ mode: 'mock', fixtures: demoResearchFixtures }), trip.enrollment.groupSpaceId);
  /** Fake bank accounts the test can change: each friend's own purchases, as a bank would report them. */
  const ledger: FundLedger = { purchases: [] };
  const fundService = opts.fundService ?? (opts.fund ? createFundService({ read: async () => { if (opts.fund === 'broken') throw new Error('bank down'); return ledger; } }, 'mock', { cacheMs: 0 }) : undefined);
  const runtime = createApplicationRuntime({ repository, conversation: chat.conversation, planner, tripId: 'h', stillLookingMs: 0, ...(fundService ? { fundService } : {}) });
  await runtime.start();
  let n = 0;
  let clock = Date.parse(opts.start ?? '2026-10-11T15:00:00Z');
  const log: Array<{ who: Who; said: string; heard: Heard }> = [];
  const collect = (from: number): Heard => {
    const out = messenger.sent.slice(from);
    const to = (w: Who) => out.filter((s) => s.audience.kind === 'private' && s.audience.providerUserId === PHONES[w]).map((s) => s.text);
    return { mason: to('mason'), alex: to('alex'), jordan: to('jordan'), all: out.map((s) => s.text) };
  };
  const settle = async () => { await runtime.drainOutbox(); await runtime.waitForIdle(); await runtime.drainOutbox(); };
  const say = async (who: Who, text: string, o: { secondsLater?: number } = {}) => {
    clock += (o.secondsLater ?? 20) * 1000;
    const before = messenger.sent.length;
    await messenger.emit(dmEvent(PHONES[who], `m${++n}`, text, { occurredAt: new Date(clock).toISOString() }));
    await settle();
    const heard = collect(before);
    log.push({ who, said: text, heard });
    return heard;
  };
  const react = async (who: Who, targetMessageId: string, emoji: string) => {
    clock += 20_000;
    const before = messenger.sent.length;
    await messenger.emit(dmEvent(PHONES[who], `r${++n}`, '', { occurredAt: new Date(clock).toISOString(), reaction: { targetMessageId, emoji } }));
    await settle();
    return collect(before);
  };
  const advance = (hours: number) => { clock += hours * 3_600_000; };
  /** provider message id of the last message sent to this person that contains the text */
  const lastIdTo = (who: Who, re: RegExp) => {
    for (let i = messenger.sent.length - 1; i >= 0; i--) {
      const s = messenger.sent[i]!;
      if (s.audience.kind === 'private' && s.audience.providerUserId === PHONES[who] && re.test(s.text)) return s.providerMessageId;
    }
    return undefined;
  };
  const state = async () => (await repository.loadTrip('h'))!;
  const everyOutbound = () => messenger.sent.map((s) => ({ to: s.audience.kind === 'private' ? s.audience.providerUserId : 'group', text: s.text }));
  /** `who` paid `dollars` for something in `category` with their own money. */
  const paid = (who: Who, dollars: number, category: string, date?: string) => { ledger.purchases.push({ id: `p${ledger.purchases.length + 1}`, memberId: who, amountDollars: dollars, category, status: 'completed', ...(date ? { date } : {}) }); };
  return { ledger, paid, say, react, advance, lastIdTo, state, everyOutbound, log, repository, messenger, runtime, stop: async () => { await runtime.stop(); repository.close(); } };
}
export type Humans = Awaited<ReturnType<typeof humans>>;

export const FULL_MASON = "I'm leaving from Chapel Hill, 2 nights, I want to go to Boone, I have a car, I'm free Nov 14-17, my max is $200, I like hiking and a town visit";

/** Everything three people need to say for options to come, ending at the proposal. */
export async function reachOptions(h: Humans, caps = { mason: 200, alex: 250, jordan: 300 }) {
  await h.say('mason', FULL_MASON.replace('$200', `$${caps.mason}`));
  await h.say('alex', `I'm free Nov 14-17, my max is $${caps.alex}, I like hiking`);
  await h.say('alex', 'yes that works');
  await h.say('jordan', `I'm free Nov 14-17, my max is $${caps.jordan}, I like a town visit`);
  return h.say('jordan', 'yes that works');
}

/** Rules every outbound message must obey, whatever the scenario. Returns the problems found. */
export function lint(h: Humans): string[] {
  const bad: string[] = [];
  for (const { to, text } of h.everyOutbound()) {
    if (/\b(cand-|gem-opt-|undefined|NaN|\[object)/.test(text)) bad.push(`jargon: ${text.slice(0, 80)}`);
    if (/\bboth of you\b|\byou two\b|\beither of you\b/i.test(text)) bad.push(`two-person wording with 3 people: ${text.slice(0, 80)}`);
    if (/—/.test(text)) bad.push(`em dash: ${text.slice(0, 80)}`);
    if (/\byour max\b/i.test(text) && /\$\d/.test(text) && to === 'group') bad.push(`cap shown publicly: ${text.slice(0, 80)}`);
    if ((text.match(/\?/g) ?? []).length > 2 && !/^Good news/.test(text)) bad.push(`more than 2 questions: ${text.slice(0, 80)}`);
  }
  return bad;
}
