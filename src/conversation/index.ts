import type { ConversationService, InboundMessage, OutboundMessage, ParseResult, SendResult, TripConversationContext } from './contracts-local.js';
import { normalizeEvent } from './normalize.js';
import { createParser } from './parser.js';
import type { ConversationDependencies } from './types.js';

export type { ConversationDependencies, IntentModel, Messenger, RawProviderEvent } from './types.js';
export type * from './contracts-local.js';
export { MockIntentModel, MockMessenger } from './mock.js';
export { normalizeEvent } from './normalize.js';

export function createConversationService(deps: ConversationDependencies): ConversationService {
  const parser = createParser(deps);
  const { trip, messenger } = deps;

  function member(memberId: string) {
    const m = trip.members.find((x) => x.userId === memberId);
    if (!m) throw new Error(`Unknown private recipient: ${memberId}`);
    return m;
  }

  async function sendPrivate(memberId: string, text: string) {
    const m = member(memberId);
    const sent = await messenger.send({ kind: 'private', providerUserId: m.providerUserId }, text);
    return { memberId, providerMessageId: sent.providerMessageId };
  }

  async function sendMessage(message: OutboundMessage): Promise<SendResult> {
    if (message.audience.kind === 'private') {
      const d = await sendPrivate(message.audience.memberId, message.text);
      return { providerMessageId: d.providerMessageId, deliveries: [d] };
    }
    if (message.audience.spaceId !== trip.groupSpaceId) throw new Error('Refusing to send to a space outside the enrolled trip');
    if (trip.mode === 'group') {
      const sent = await messenger.send({ kind: 'group', spaceId: trip.groupSpaceId }, message.text);
      return { providerMessageId: sent.providerMessageId, deliveries: [] };
    }
    // direct mode: the "group" is everyone's one-on-one thread with the assistant.
    const deliveries: SendResult['deliveries'] = [];
    const failedMemberIds: string[] = [];
    for (const m of trip.members) {
      try {
        deliveries.push(await sendPrivate(m.userId, message.text));
      } catch {
        failedMemberIds.push(m.userId);
      }
    }
    if (deliveries.length === 0) throw new Error('Direct broadcast failed for every member');
    return { providerMessageId: deliveries[0]!.providerMessageId, deliveries, ...(failedMemberIds.length ? { failedMemberIds } : {}) };
  }

  return {
    parseInbound: (message: InboundMessage, context?: TripConversationContext): Promise<ParseResult> => parser.parse(message, context),
    sendMessage,
    async start(onMessage) {
      await messenger.subscribe(async (raw) => {
        const normalized = normalizeEvent(raw, trip);
        if (normalized) await onMessage(normalized);
      });
    },
    stop: () => messenger.stop(),
  };
}
