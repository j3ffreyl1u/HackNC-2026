import { describe, expect, it } from 'vitest';
import { createConversationService } from '../../src/conversation/index.js';
import { MockIntentModel } from '../../src/conversation/mock.js';
import { createSpectrumMessenger, mapSpectrumMessage, type SpectrumAppLike, type SpectrumMessageLike, type SpectrumSpaceLike } from '../../src/conversation/spectrum.js';
import { baseContext, trip } from './helpers.js';

const t = new Date('2026-10-01T12:00:00Z');
const group = (sent: string[] = []): SpectrumSpaceLike => ({ id: 'grp-1', type: 'group', send: async (s) => (sent.push(s), { id: `out-${sent.length}` }) });
const dm: SpectrumSpaceLike = { id: 'dm-1', type: 'dm', send: async () => ({ id: 'dm-out' }) };
const text = (over: Partial<SpectrumMessageLike> = {}): SpectrumMessageLike => ({ id: 'm1', direction: 'inbound', sender: { id: 'p-alex' }, timestamp: t, content: { type: 'text', text: 'summary' }, ...over });

describe('mapSpectrumMessage', () => {
  it('maps inbound text in a group and in a DM', () => {
    expect(mapSpectrumMessage(group(), text())).toMatchObject({ messageId: 'm1', providerUserId: 'p-alex', spaceId: 'grp-1', isDirect: false, fromSelf: false, text: 'summary' });
    expect(mapSpectrumMessage(dm, text())?.isDirect).toBe(true);
  });
  it('flags outbound messages as from self', () => {
    expect(mapSpectrumMessage(group(), text({ direction: 'outbound' }))?.fromSelf).toBe(true);
  });
  it('maps a reaction to its target message id with its own event id', () => {
    const r = mapSpectrumMessage(group(), text({ id: 'rx1', content: { type: 'reaction', emoji: '👍', target: { id: 'bot-9' } } }));
    expect(r).toMatchObject({ messageId: 'rx1', eventId: 'reaction:rx1', reaction: { targetMessageId: 'bot-9', emoji: '👍' } });
  });
  it('skips sender-less events, attachments and malformed reactions', () => {
    expect(mapSpectrumMessage(group(), text({ sender: undefined }))).toBeNull();
    expect(mapSpectrumMessage(group(), text({ content: { type: 'attachment' } }))).toBeNull();
    expect(mapSpectrumMessage(group(), text({ content: { type: 'reaction', emoji: '👍' } as never }))).toBeNull();
  });
  it('treats a space with unknown type as a group, never a DM', () => {
    expect(mapSpectrumMessage({ ...group(), type: undefined }, text())?.isDirect).toBe(false);
  });
});

describe('Spectrum messenger loop', () => {
  it('feeds events through the service, survives a handler error, and sends replies', async () => {
    const gs = group();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app: SpectrumAppLike = {
      messages: (async function* () {
        yield [gs, text({ id: 'a', direction: 'outbound' })] as [SpectrumSpaceLike, SpectrumMessageLike];
        yield [gs, text({ id: 'b' })] as [SpectrumSpaceLike, SpectrumMessageLike];
        yield [gs, text({ id: 'c', sender: { id: 'p-stranger' } })] as [SpectrumSpaceLike, SpectrumMessageLike];
        await gate;
      })(),
      stop: async () => release(),
    };
    const created: string[] = [];
    const messenger = createSpectrumMessenger({
      app, trip,
      imessage: { user: async (id) => id, space: { get: async () => gs, create: async (u) => (created.push(String(u)), dm) } },
    });
    const service = createConversationService({ trip, messenger, intentModel: new MockIntentModel(), getConversationContext: async () => baseContext });
    const seen: string[] = [];
    await service.start(async (m) => { seen.push(m.eventId); if (m.eventId === 'message:b') throw new Error('boom'); });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['message:b']); // own message and stranger dropped; error did not stop the loop

    const grp = await service.sendMessage({ deliveryId: 'd1', audience: { kind: 'group', spaceId: 'grp-1' }, text: 'hello' });
    const pm = await service.sendMessage({ deliveryId: 'd2', audience: { kind: 'private', memberId: 'jordan' }, text: 'psst' });
    expect(grp.providerMessageId).toBe('out-1');
    expect(pm.providerMessageId).toBe('dm-out');
    expect(created).toEqual(['p-jordan']);
    await service.stop();
  });
  it('reports uncertain delivery instead of inventing a message id', async () => {
    const messenger = createSpectrumMessenger({
      app: { messages: (async function* () {})(), stop: async () => {} }, trip,
      imessage: { user: async () => 1, space: { get: async () => ({ id: 'grp-1', send: async () => undefined }), create: async () => dm } },
    });
    await expect(messenger.send({ kind: 'group', spaceId: 'grp-1' }, 'x')).rejects.toThrow(/uncertain/);
  });
});
