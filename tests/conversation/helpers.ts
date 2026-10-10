import type { HouseholdConfig } from '../../src/contracts/index.js';
import { MockIntentModel, MockMessenger } from '../../src/conversation/mock.js';
import { createConversationService } from '../../src/conversation/index.js';
import type { ParserContext } from '../../src/conversation/types.js';
import type { RawIntent, IntentInput } from '../../src/conversation/types.js';

export const household: HouseholdConfig = {
  householdId: 'demo-house', groupSpaceId: 'grp-1', designatedPayerId: 'mason', householdAccountId: 'acct-house',
  members: [
    { userId: 'mason', displayName: 'Mason', providerUserId: 'p-mason', bankAccountId: 'b1' },
    { userId: 'alex', displayName: 'Alex', providerUserId: 'p-alex', bankAccountId: 'b2' },
    { userId: 'jordan', displayName: 'Jordan', providerUserId: 'p-jordan', bankAccountId: 'b3' },
  ],
  recipients: [{ recipientId: 'duke-energy', displayName: 'Duke Energy Electricity', bankAccountId: 'r1' }],
  demoCycles: [],
};

export const baseContext: ParserContext = { householdId: 'demo-house', cycleId: '2026-10', openBills: [], actionableProposals: [] };

export function setup(ctx: Partial<ParserContext> | ((actor: string, space: string, target?: string) => ParserContext) = {}, script?: (i: IntentInput) => RawIntent) {
  const messenger = new MockMessenger();
  const model = new MockIntentModel(script);
  const lookups: Array<[string, string, string | undefined]> = [];
  const service = createConversationService({
    household, messenger, intentModel: model,
    getConversationContext: async (actor, space, target) => {
      lookups.push([actor, space, target]);
      return typeof ctx === 'function' ? ctx(actor, space, target) : { ...baseContext, ...ctx };
    },
  });
  return { service, messenger, model, lookups };
}

export const msg = (over: Record<string, unknown>) => ({
  eventId: 'e1', messageId: 'm1', senderId: 'mason', spaceId: 'grp-1', visibility: 'group' as const, occurredAt: '2026-10-01T12:00:00Z', ...over,
});
