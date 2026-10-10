import type { ChatMode, InboundMessage, TripConfig, TripConversationContext } from '../../src/conversation/contracts-local.js';
import { createConversationService } from '../../src/conversation/index.js';
import { MockIntentModel, MockMessenger } from '../../src/conversation/mock.js';
import type { IntentInput, RawIntent } from '../../src/conversation/types.js';

export const members = [
  { userId: 'mason', displayName: 'Mason', providerUserId: 'p-mason' },
  { userId: 'alex', displayName: 'Alex', providerUserId: 'p-alex' },
  { userId: 'jordan', displayName: 'Jordan', providerUserId: 'p-jordan' },
];
export const tripFor = (mode: ChatMode = 'group'): TripConfig => ({ tripId: 'trip-1', mode, groupSpaceId: 'grp-1', timezone: 'America/New_York', members });
export const trip = tripFor('group');

export const baseContext: TripConversationContext = { tripId: 'trip-1', revision: 1, actionable: [] };

export function setup(
  ctx: Partial<TripConversationContext> | ((actor: string, space: string, target?: string) => TripConversationContext) = {},
  script?: (i: IntentInput) => RawIntent,
  mode: ChatMode = 'group',
) {
  const t = tripFor(mode);
  const messenger = new MockMessenger();
  const model = new MockIntentModel(script);
  const lookups: Array<[string, string, string | undefined]> = [];
  const service = createConversationService({
    trip: t, messenger, intentModel: model,
    getConversationContext: async (actor, space, target) => {
      lookups.push([actor, space, target]);
      return typeof ctx === 'function' ? ctx(actor, space, target) : { ...baseContext, ...ctx };
    },
  });
  return { service, messenger, model, lookups, trip: t };
}

export const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  eventId: 'e1', messageId: 'm1', senderId: 'mason', spaceId: 'grp-1', visibility: 'group', occurredAt: '2026-10-01T12:00:00Z', ...over,
});
