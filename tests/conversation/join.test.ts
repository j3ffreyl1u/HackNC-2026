import { describe, expect, it } from 'vitest';
import { createConversationService, MockIntentModel, MockMessenger, parseJoinCode } from '../../src/conversation/index.js';
import { dmEvent, groupEvent } from '../../src/conversation/mock.js';
import { baseContext, tripFor } from './helpers.js';

describe('parseJoinCode', () => {
  it.each([
    ['join 4F7K', '4F7K'], ['JOIN-4F7K', '4F7K'], ['Join code: 4f7k', '4F7K'], ['join code 4F7K.', '4F7K'],
    ['I want to join the trip with code 4F7K', '4F7K'], ['please join trip 4F7K', '4F7K'], ['Use code 4F7K to join', '4F7K'],
    ['join TRIP-9XQ2', 'TRIP-9XQ2'],
  ])('%s -> %s', (text, code) => expect(parseJoinCode(text)).toBe(code));

  it('does not mistake ordinary sentences for a code (a code needs a digit)', () => {
    for (const t of ['join us', 'join now', 'can you join us for dinner', "let's join the trip", 'join', 'join 12', 'join code', 'my code is 4F7K', 'hello 4F7K']) {
      expect(parseJoinCode(t), t).toBeNull();
    }
  });
});

describe('join codes through the service (opt-in)', () => {
  const build = (joinCodes?: boolean) => {
    const trip = tripFor('direct');
    const messenger = new MockMessenger();
    const service = createConversationService({
      trip, messenger, intentModel: new MockIntentModel(), ...(joinCodes === undefined ? {} : { joinCodes }),
      getConversationContext: async () => baseContext,
    });
    return { service, messenger, trip };
  };
  const collect = async (joinCodes: boolean | undefined, ...events: ReturnType<typeof dmEvent>[]) => {
    const { service, messenger } = build(joinCodes);
    const got: any[] = [];
    await service.start(async (m) => void got.push(m));
    for (const e of events) await messenger.emit(e);
    return { got, service };
  };

  it('is off by default: a stranger texting a code is dropped like any other stranger', async () => {
    expect((await collect(undefined, dmEvent('+15550001111', 'm1', 'join 4F7K'))).got).toEqual([]);
    expect((await collect(false, dmEvent('+15550001111', 'm1', 'join 4F7K'))).got).toEqual([]);
  });

  it('when enabled, a stranger gets through ONLY with a join-code DM, as a guest identity', async () => {
    const { got, service } = await collect(true,
      dmEvent('+15550001111', 'm1', 'join 4F7K'),
      dmEvent('+15550001111', 'm2', 'my max is $50'),                 // not a join: dropped
      dmEvent('+15550001111', 'm3', '', { text: undefined, reaction: { targetMessageId: 'x', emoji: '👍' } }), // reaction: dropped
      groupEvent(tripFor('group'), '+15550001111', 'm4', 'join 4F7K'),  // group space: dropped
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ senderId: 'guest:+15550001111', visibility: 'private' });
    const r = await service.parseInbound(got[0]);
    expect(r.kind).toBe('command');
    expect(r.kind === 'command' && r.command).toMatchObject({
      actorId: 'guest:+15550001111', tripId: 'trip-1', action: { kind: 'join_trip', code: '4F7K', providerUserId: '+15550001111' },
    });
  });

  it('a guest can never do anything but join, even if the message reaches the parser', async () => {
    const { service } = build(true);
    const base = { eventId: 'e', messageId: 'm', senderId: 'guest:+15550001111', spaceId: 'dm', visibility: 'private' as const, occurredAt: '2026-10-01T12:00:00Z' };
    for (const text of ['my max is $50', 'accept cand-a v1', 'yes', 'show us options']) expect((await service.parseInbound({ ...base, text })).kind, text).toBe('ignored');
    expect((await service.parseInbound({ ...base, text: 'join 4F7K', visibility: 'group' })).kind).toBe('ignored');
    expect((await build(false).service.parseInbound({ ...base, text: 'join 4F7K' })).kind).toBe('ignored'); // flag off
  });

  it('an enrolled member who sends a code is told they are already in, privately, with no command', async () => {
    const { service } = build(true);
    const r = await service.parseInbound({ eventId: 'e', messageId: 'm', senderId: 'mason', spaceId: 'dm-mason', visibility: 'private', occurredAt: '2026-10-01T12:00:00Z', text: 'join 4F7K' });
    expect(r.kind).toBe('reply');
    expect(r.kind === 'reply' && r.message.audience).toEqual({ kind: 'private', memberId: 'mason' });
    expect(r.kind === 'reply' && r.message.text).toMatch(/already on this trip/);
  });
});
