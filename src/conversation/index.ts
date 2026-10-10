import type { ConversationService, InboundMessage, OutboundMessage, ParseResult } from '../contracts/index.js';
import { normalizeEvent } from './normalize.js';
import { createParser } from './parser.js';
import type { ConversationDependencies, MessengerAudience } from './types.js';

export type { ConversationDependencies, IntentModel, Messenger, ParserContext, RawProviderEvent } from './types.js';
export { MockIntentModel, MockMessenger } from './mock.js';
export { normalizeEvent } from './normalize.js';

export function createConversationService(deps: ConversationDependencies): ConversationService {
  const parser = createParser(deps);
  const { household, messenger } = deps;

  function audienceFor(message: OutboundMessage): MessengerAudience {
    if (message.audience.kind === 'group') {
      if (message.audience.spaceId !== household.groupSpaceId) throw new Error('Refusing to send to a space outside the enrolled household');
      return { kind: 'group', spaceId: message.audience.spaceId };
    }
    const userId = message.audience.userId;
    const member = household.members.find((m) => m.userId === userId);
    if (!member) throw new Error(`Unknown private recipient: ${userId}`);
    return { kind: 'private', providerUserId: member.providerUserId };
  }

  return {
    parseInbound: (message: InboundMessage): Promise<ParseResult> => parser.parse(message),
    sendMessage: async (message: OutboundMessage) => messenger.send(audienceFor(message), message.text),
    async start(onMessage) {
      await messenger.subscribe(async (raw) => {
        const normalized = normalizeEvent(raw, household);
        if (normalized) await onMessage(normalized);
      });
    },
    stop: () => messenger.stop(),
  };
}
