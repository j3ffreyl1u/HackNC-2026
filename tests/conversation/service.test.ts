import { describe, expect, it } from 'vitest';
import { dmEvent, groupEvent } from '../../src/conversation/mock.js';
import { household, setup } from './helpers.js';

describe('inbound normalization via start()', () => {
  it('drops self messages, strangers, unrelated groups and removed reactions', async () => {
    const { service, messenger } = setup();
    const got: string[] = [];
    await service.start(async (m) => void got.push(m.eventId));
    await messenger.emit(groupEvent(household, 'p-mason', 'm1', 'hi', { fromSelf: true }));
    await messenger.emit(groupEvent(household, 'p-stranger', 'm2', 'hi'));
    await messenger.emit(groupEvent(household, 'p-mason', 'm3', 'hi', { spaceId: 'other' }));
    await messenger.emit(groupEvent(household, 'p-mason', 'm4', '', { text: undefined, reaction: { targetMessageId: 'x', emoji: '👍', removed: true } }));
    expect(got).toEqual([]);
  });
  it('maps provider ids to internal members with stable event ids on retry', async () => {
    const { service, messenger } = setup();
    const got: any[] = [];
    await service.start(async (m) => void got.push(m));
    await messenger.emit(groupEvent(household, 'p-alex', 'm1', 'summary'));
    await messenger.emit(groupEvent(household, 'p-alex', 'm1', 'summary'));
    await messenger.emit(dmEvent('p-jordan', 'm2', 'hi'));
    expect(got[0]).toMatchObject({ senderId: 'alex', visibility: 'group' });
    expect(got[0].eventId).toBe(got[1].eventId);
    expect(got[2]).toMatchObject({ senderId: 'jordan', visibility: 'private' });
  });
  it('reaction events keep a distinct event id from the target message', async () => {
    const { service, messenger } = setup();
    const got: any[] = [];
    await service.start(async (m) => void got.push(m));
    await messenger.emit(groupEvent(household, 'p-alex', 'm5', '', { text: undefined, reaction: { targetMessageId: 'bot-1', emoji: '👍' } }));
    expect(got[0].eventId).not.toBe('bot-1');
    expect(got[0].reaction).toEqual({ targetMessageId: 'bot-1', emoji: '👍' });
  });
});

describe('sendMessage', () => {
  it('routes group and private audiences to the provider', async () => {
    const { service, messenger } = setup();
    const a = await service.sendMessage({ deliveryId: 'd1', householdId: 'demo-house', audience: { kind: 'group', spaceId: 'grp-1' }, text: 'hi all' });
    await service.sendMessage({ deliveryId: 'd2', householdId: 'demo-house', audience: { kind: 'private', userId: 'jordan' }, text: 'hi' });
    expect(a.providerMessageId).toBe('mock-msg-1');
    expect(messenger.sent[1]!.audience).toEqual({ kind: 'private', providerUserId: 'p-jordan' });
  });
  it('refuses to send outside the enrolled household', async () => {
    const { service } = setup();
    await expect(service.sendMessage({ deliveryId: 'd', householdId: 'h', audience: { kind: 'group', spaceId: 'nope' }, text: 'x' })).rejects.toThrow();
    await expect(service.sendMessage({ deliveryId: 'd', householdId: 'h', audience: { kind: 'private', userId: 'nobody' }, text: 'x' })).rejects.toThrow();
  });
  it('stop shuts the messenger', async () => {
    const { service, messenger } = setup();
    await service.stop();
    expect(messenger.stopped).toBe(true);
  });
});
