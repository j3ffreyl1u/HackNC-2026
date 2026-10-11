import { toIntervalWindows } from '../../src/conversation/dates.js';
import { createConversationService, MockMessenger } from '../../src/conversation/index.js';
import type { ParseResult, TripConversationContext } from '../../src/conversation/contracts-local.js';
import type { IntentModel } from '../../src/conversation/types.js';
import { members } from './helpers.js';
import type { Case } from './corpus.js';

export interface Outcome {
  kind: ParseResult['kind'];
  updates: Array<Record<string, any>>;
  actions: string[];
  reply: string;
}

const TZ = 'America/New_York';
let n = 0;

/** Runs one DM through the real parser (direct mode, the shipped topology) with the given language model. */
export async function runCase(testCase: Case, intentModel: IntentModel): Promise<Outcome> {
  const trip = { tripId: 'corpus', mode: 'direct' as const, groupSpaceId: 'direct:corpus', timezone: TZ, members };
  const context: TripConversationContext = { tripId: 'corpus', revision: 1, actionable: [], ...(testCase.pending ? { pendingQuestion: { field: testCase.pending } } : {}) };
  const service = createConversationService({ trip, intentModel, messenger: new MockMessenger(), getConversationContext: async () => context });
  const r = await service.parseInbound({
    eventId: `c${++n}`, messageId: `c${n}`, senderId: 'jordan', spaceId: 'dm-jordan', visibility: 'private', occurredAt: '2026-10-11T12:00:00Z', text: testCase.say,
  });
  const commands = r.kind === 'command' ? [r.command] : r.kind === 'commands' ? r.commands : [];
  return {
    kind: r.kind,
    updates: commands.flatMap((cmd) => (cmd.action.kind === 'update_constraint' ? [cmd.action.update as Record<string, any>] : [])),
    actions: commands.flatMap((cmd) => (cmd.action.kind === 'update_constraint' ? [] : [cmd.action.kind])),
    reply: r.kind === 'reply' ? r.message.text : r.kind === 'commands' ? r.clarification?.text ?? '' : '',
  };
}

/** Returns what was wrong, or an empty list. */
export function check(testCase: Case, o: Outcome): string[] {
  const e = testCase.expect;
  const bad: string[] = [];
  const get = (field: string) => o.updates.find((u) => u.field === field);
  if (e.budget !== undefined && get('budget')?.value !== e.budget) bad.push(`budget ${get('budget')?.value ?? 'missing'} != ${e.budget}`);
  if (e.avail) {
    const want = toIntervalWindows([{ start: e.avail[0], end: e.avail[1] }], TZ)[0]!;
    const got = (get('availability')?.value ?? []) as Array<{ startAt: string; endAt: string }>;
    if (!got.some((w) => w.startAt === want.startAt && w.endAt === want.endAt)) bad.push(`availability ${JSON.stringify(got.map((w) => w.startAt.slice(0, 10) + '..' + w.endAt.slice(0, 10)))} lacks ${e.avail.join('..')}`);
  }
  if (e.nights !== undefined && get('duration')?.value !== e.nights) bad.push(`nights ${get('duration')?.value ?? 'missing'} != ${e.nights}`);
  if (e.origin && !e.origin.test(String(get('origin')?.value ?? ''))) bad.push(`origin ${get('origin')?.value ?? 'missing'}`);
  if (e.region && !e.region.test(String(get('region')?.value ?? ''))) bad.push(`region ${get('region')?.value ?? 'missing'}`);
  if (e.maxMin !== undefined && get('region')?.maxTravelMinutes !== e.maxMin) bad.push(`maxTravelMinutes ${get('region')?.maxTravelMinutes ?? 'missing'} != ${e.maxMin}`);
  if (e.vehicle !== undefined && get('transport')?.vehicleAvailable !== e.vehicle) bad.push(`vehicleAvailable ${get('transport')?.vehicleAvailable ?? 'missing'} != ${e.vehicle}`);
  if (e.prefs && !e.prefs.test(JSON.stringify(get('preferences')?.value ?? ''))) bad.push(`preferences ${JSON.stringify(get('preferences')?.value ?? 'missing')}`);
  if (e.mustdos && !e.mustdos.test(JSON.stringify(get('must_dos')?.value ?? ''))) bad.push(`must_dos ${JSON.stringify(get('must_dos')?.value ?? 'missing')}`);
  for (const a of e.actions ?? []) if (!o.actions.includes(a)) bad.push(`missing action ${a} (got ${o.actions.join(',') || 'none'})`);
  if (e.reply && !e.reply.test(o.reply)) bad.push(`reply ${JSON.stringify(o.reply.slice(0, 80))} !~ ${e.reply}`);
  if (e.nothing && (o.updates.length || o.actions.length)) bad.push(`recorded ${o.updates.map((u) => u.field).join(',')}${o.actions.join(',')} but should be nothing`);
  for (const f of e.not ?? []) if (get(f)) bad.push(`must not record ${f}`);
  return bad;
}
