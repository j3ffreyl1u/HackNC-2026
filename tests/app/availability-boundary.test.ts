import { describe, expect, it } from 'vitest';
import { convert } from '../../src/app/conversation-adapter.js';
import { MockIntentModel, MockMessenger, createConversationService } from '../../src/conversation/index.js';

describe('A emits intervals and C passes them through unchanged', () => {
  it('parser output survives convert() byte for byte', async () => {
    const trip = { tripId: 't', mode: 'group' as const, groupSpaceId: 'g', timezone: 'America/New_York', members: [{ userId: 'mason', displayName: 'Mason', providerUserId: 'p' }] };
    const service = createConversationService({ trip, intentModel: new MockIntentModel(), messenger: new MockMessenger(), getConversationContext: async () => ({ tripId: 't', revision: 1, actionable: [] }) });
    const r = await service.parseInbound({ eventId: 'e', messageId: 'm', senderId: 'mason', spaceId: 'g', visibility: 'group', occurredAt: '2026-10-01T12:00:00Z', text: "I'm free Oct 24-26" });
    expect(r.kind).toBe('command');
    if (r.kind !== 'command') return;
    const out = convert(r.command, trip.timezone);
    const update = (out.action as { update: { value: unknown } }).update;
    expect(update.value).toEqual([{ startAt: '2026-10-24T04:00:00.000Z', endAt: '2026-10-27T04:00:00.000Z', timeZone: 'America/New_York' }]);
  });
});
