import type * as C from '../contracts/index.js';
import type * as A from '../conversation/contracts-local.js';
import { createConversationService, MockIntentModel, MockMessenger } from '../conversation/index.js';
import { createGeminiIntentModel } from '../conversation/gemini.js';
import { createSpectrumMessenger, loadSpectrumApp } from '../conversation/spectrum.js';
import type { Messenger } from '../conversation/types.js';

/** Convert a local calendar midnight to an instant, including DST changes. */
export function localMidnight(date: string, timeZone: string): string {
  const target = Date.parse(`${date}T00:00:00Z`);
  let instant = target;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(fmt.formatToParts(instant).map(p => [p.type, p.value]));
    const wall = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    instant += target - wall;
  }
  return new Date(instant).toISOString();
}

export function convert(command: A.TripCommand | C.TripCommand, timeZone: string): C.TripCommand {
  if (command.action.kind !== 'update_constraint') return command as C.TripCommand;
  const u = command.action.update;
  let value: unknown;
  switch (u.field) {
    case 'budget': case 'preferences': case 'must_dos': value = u.value; break;
    case 'availability': value = u.value.map(w => 'startAt' in w ? w : ({ startAt: localMidnight(w.start, timeZone), endAt: localMidnight(new Date(Date.parse(`${w.end}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), timeZone), timeZone })); break;
    case 'origin': case 'region': case 'duration': case 'transport': value = u.value; break;
  }
  return { ...command, action: { kind: 'update_constraint', update: { ...u, value } as C.ConstraintUpdate } };
}

export async function createChatAdapter(enrollment: C.TripEnrollment, timeZone: string, mode: 'mock' | 'photon', env = process.env, suppliedMessenger?: Messenger): Promise<{ conversation: C.ConversationService; messenger: Messenger }> {
  const trip: A.TripConfig = { tripId: enrollment.tripId, groupSpaceId: enrollment.groupSpaceId, timezone: timeZone, mode: enrollment.mode ?? 'group', members: enrollment.participants.map(p => ({ userId: p.memberId, displayName: p.displayName, providerUserId: p.providerUserId })) };
  let messenger: Messenger = suppliedMessenger ?? new MockMessenger();
  if (mode === 'photon') {
    if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required for live chat intent parsing.');
    const live = await loadSpectrumApp({ projectId: env.SPECTRUM_PROJECT_ID!, projectSecret: env.SPECTRUM_PROJECT_SECRET! });
    messenger = createSpectrumMessenger({ ...live, trip, onError: () => console.error('Spectrum transport failed; check the connection and retry.') });
  }
  const service = createConversationService({ trip, messenger,
    intentModel: mode === 'photon' || (env.INTENT_MODEL === 'gemini' && env.GEMINI_API_KEY) ? createGeminiIntentModel({ apiKey: env.GEMINI_API_KEY!, model: env.GEMINI_INTENT_MODEL || env.GEMINI_MODEL || 'gemini-3.8-flash' }) : new MockIntentModel(),
    getConversationContext: async () => ({ tripId: trip.tripId, revision: 0, actionable: [] }),
  });
  return { messenger, conversation: {
    start: callback => service.start(callback), stop: () => service.stop(),
    async sendMessage(message) {
      const result = await service.sendMessage(message);
      if (result.failedMemberIds?.length) throw new Error('Some recipients did not receive the message.');
      return [...new Set([result.providerMessageId, ...result.deliveries.map(d => d.providerMessageId)])].map(providerMessageId => ({ providerMessageId }));
    },
    async parseInbound(message, context) {
      const stop = /^confirm stop (\S+) v(\d+) ([^|]+)\|\s*([^|]+)\|\s*([^|]+)(?:\|\s*(.*))?$/i.exec(message.text?.trim() ?? '');
      if (stop) return { kind: 'command', command: { commandId: message.eventId, eventId: message.eventId, actorId: message.senderId, tripId: context.tripId, action: { kind: 'confirm_stop', candidateId: stop[1], revision: Number(stop[2]), sourceMessageId: message.messageId, item: { itemId: `stop:${message.eventId}`, location: stop[3].trim(), startAt: stop[4].trim(), endAt: stop[5].trim(), tags: (stop[6] ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean), evidenceIds: [] } } } };
      const cost = /^confirm cost (\S+) v(\d+) (\S+) \$(\d+(?:\.\d{1,2})?)(?:-\$(\d+(?:\.\d{1,2})?))?$/i.exec(message.text?.trim() ?? '');
      if (cost) return { kind: 'command', command: { commandId: message.eventId, eventId: message.eventId, actorId: message.senderId, tripId: context.tripId,
        action: { kind: 'confirm_cost', candidateId: cost[1], revision: Number(cost[2]), costId: cost[3], lowCents: Math.round(Number(cost[4]) * 100), highCents: Math.round(Number(cost[5] ?? cost[4]) * 100), sourceMessageId: message.messageId } } };
      const actionable: A.ActionableItem[] = context.actionable.flatMap(p => p.actions.map(action => ({ kind: action === 'pick' ? 'select' as const : 'accept' as const, candidateId: p.candidateId, revision: p.revision, description: p.title })));
      const parsed = await service.parseInbound(message, { tripId: context.tripId, revision: context.revision, actionable,
        pendingQuestion: context.pendingQuestion,
        ...(context.confirmBasics ? { confirmBasics: context.confirmBasics } : {}),
        ...(context.openFields?.length ? { openFields: context.openFields } : {}),
        pendingConfirmation: context.pendingConfirmation,
        targetProposal: context.targetProposal?.kind ? { ...context.targetProposal, kind: context.targetProposal.kind } : undefined });
      if (parsed.kind === 'ignored') return parsed;
      if (parsed.kind === 'reply') return { kind: 'reply', message: parsed.message, expects: parsed.expects };
      if (parsed.kind === 'command') return { kind: 'command', command: convert(parsed.command, timeZone) };
      return { kind: 'commands', commands: parsed.commands.map(c => convert(c, timeZone)), clarificationQuestion: parsed.clarification?.text, ...(parsed.acknowledgement ? { acknowledgement: parsed.acknowledgement.text } : {}), expects: parsed.expects };
    },
  } };
}
