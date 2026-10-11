import { describe, expect, it } from 'vitest';
import { dmEvent, groupEvent } from '../../src/conversation/mock.js';
import { setup, trip } from './helpers.js';

describe('inbound normalization via start() (group mode)', () => {
  it('drops self messages, strangers, unrelated groups and removed reactions', async () => {
    const { service, messenger } = setup();
    const got: string[] = [];
    await service.start(async (m) => void got.push(m.eventId));
    await messenger.emit(groupEvent(trip, 'p-mason', 'm1', 'hi', { fromSelf: true }));
    await messenger.emit(groupEvent(trip, 'p-stranger', 'm2', 'hi'));
    await messenger.emit(groupEvent(trip, 'p-mason', 'm3', 'hi', { spaceId: 'other' }));
    await messenger.emit(groupEvent(trip, 'p-mason', 'm4', '', { text: undefined, reaction: { targetMessageId: 'x', emoji: '👍', removed: true } }));
    expect(got).toEqual([]);
  });
  it('maps provider ids to members with stable event ids on retry; accepts private DMs too', async () => {
    const { service, messenger } = setup();
    const got: any[] = [];
    await service.start(async (m) => void got.push(m));
    await messenger.emit(groupEvent(trip, 'p-alex', 'm1', 'summary'));
    await messenger.emit(groupEvent(trip, 'p-alex', 'm1', 'summary'));
    await messenger.emit(dmEvent('p-jordan', 'm2', 'hi'));
    expect(got[0]).toMatchObject({ senderId: 'alex', visibility: 'group' });
    expect(got[0].eventId).toBe(got[1].eventId);
    expect(got[2]).toMatchObject({ senderId: 'jordan', visibility: 'private' });
  });
  it('reaction events keep a distinct event id from the target message', async () => {
    const { service, messenger } = setup();
    const got: any[] = [];
    await service.start(async (m) => void got.push(m));
    await messenger.emit(groupEvent(trip, 'p-alex', 'm5', '', { text: undefined, reaction: { targetMessageId: 'bot-1', emoji: '👍' } }));
    expect(got[0].eventId).not.toBe('bot-1');
    expect(got[0].reaction).toEqual({ targetMessageId: 'bot-1', emoji: '👍' });
  });
});

describe('sendMessage (group mode)', () => {
  it('routes group and private audiences to the provider', async () => {
    const { service, messenger } = setup();
    const a = await service.sendMessage({ deliveryId: 'd1', audience: { kind: 'group', spaceId: 'grp-1' }, text: 'hi all' });
    await service.sendMessage({ deliveryId: 'd2', audience: { kind: 'private', memberId: 'jordan' }, text: 'hi' });
    expect(a.providerMessageId).toBe('mock-msg-1');
    expect(messenger.sent[0]!.audience).toEqual({ kind: 'group', spaceId: 'grp-1' });
    expect(messenger.sent[1]!.audience).toEqual({ kind: 'private', providerUserId: 'p-jordan' });
  });
  it('refuses to send outside the enrolled trip', async () => {
    const { service } = setup();
    await expect(service.sendMessage({ deliveryId: 'd', audience: { kind: 'group', spaceId: 'nope' }, text: 'x' })).rejects.toThrow();
    await expect(service.sendMessage({ deliveryId: 'd', audience: { kind: 'private', memberId: 'nobody' }, text: 'x' })).rejects.toThrow();
  });
  it('stop shuts the messenger', async () => {
    const { service, messenger } = setup();
    await service.stop();
    expect(messenger.stopped).toBe(true);
  });
});

describe('direct (one-on-one) mode: same product without a group chat', () => {
  it('accepts only DMs from enrolled members; group-space events are dropped', async () => {
    const { service, messenger, trip: t } = setup({}, undefined, 'direct');
    const got: any[] = [];
    await service.start(async (m) => void got.push(m));
    await messenger.emit(groupEvent(t, 'p-alex', 'g1', 'my max is $200'));
    await messenger.emit(dmEvent('p-alex', 'd1', 'my max is $200'));
    await messenger.emit(dmEvent('p-stranger', 'd2', 'hi'));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ senderId: 'alex', visibility: 'private' });
  });
  it('parses a DM the same way and replies privately', async () => {
    const { service } = setup({}, undefined, 'direct');
    const r = await service.parseInbound({ eventId: 'e', messageId: 'm', senderId: 'alex', spaceId: 'dm-alex', visibility: 'private', occurredAt: '2026-10-01T12:00:00Z', text: 'my max is $250' });
    expect(r.kind === 'commands' && r.commands[0]!.action).toMatchObject({ kind: 'update_constraint', update: { memberId: 'alex', field: 'budget', value: 25000 } });
    expect(r.kind === 'commands' && r.clarification?.audience).toEqual({ kind: 'private', memberId: 'alex' });
    const q = await service.parseInbound({ eventId: 'e2', messageId: 'm2', senderId: 'alex', spaceId: 'dm-alex', visibility: 'private', occurredAt: '2026-10-01T12:00:00Z', text: 'I might spend $250' });
    expect(q.kind === 'reply' && q.message.audience).toEqual({ kind: 'private', memberId: 'alex' });
  });
  it('a group-audience message becomes an individual DM to every member and reports each delivery', async () => {
    const { service, messenger } = setup({}, undefined, 'direct');
    const r = await service.sendMessage({ deliveryId: 'd', audience: { kind: 'group', spaceId: 'grp-1' }, text: 'Two options are ready' });
    expect(messenger.sent.map((s) => s.audience)).toEqual([
      { kind: 'private', providerUserId: 'p-mason' },
      { kind: 'private', providerUserId: 'p-alex' },
      { kind: 'private', providerUserId: 'p-jordan' },
    ]);
    expect(r.deliveries.map((d) => d.memberId)).toEqual(['mason', 'alex', 'jordan']);
    expect(r.failedMemberIds).toBeUndefined();
  });
  it('reports partial failure instead of hiding it, and throws only if nobody was reached', async () => {
    const { service, messenger } = setup({}, undefined, 'direct');
    const send = messenger.send.bind(messenger);
    messenger.send = async (a, t) => { if (a.kind === 'private' && a.providerUserId === 'p-alex') throw new Error('x'); return send(a, t); };
    const r = await service.sendMessage({ deliveryId: 'd', audience: { kind: 'group', spaceId: 'grp-1' }, text: 'hi' });
    expect(r.failedMemberIds).toEqual(['alex']);
    expect(r.deliveries).toHaveLength(2);
    messenger.send = async () => { throw new Error('down'); };
    await expect(service.sendMessage({ deliveryId: 'd2', audience: { kind: 'group', spaceId: 'grp-1' }, text: 'hi' })).rejects.toThrow();
  });
  it('a single-member trip works as plain one-on-one', async () => {
    const { service, messenger, trip: t } = setup({}, undefined, 'direct');
    t.members.splice(1); // only mason
    const r = await service.sendMessage({ deliveryId: 'd', audience: { kind: 'group', spaceId: 'grp-1' }, text: 'hi' });
    expect(r.deliveries).toHaveLength(1);
    expect(messenger.sent).toHaveLength(1);
  });
});
