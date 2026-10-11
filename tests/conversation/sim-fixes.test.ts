import { describe, expect, it } from 'vitest';
import { extractConstraints } from '../../src/conversation/constraints.js';
import { parseDateWindows } from '../../src/conversation/dates.js';
import type { ParseResult } from '../../src/conversation/contracts-local.js';
import { msg, setup } from './helpers.js';

const REF = '2026-10-14T12:00:00Z';   // a Wednesday
const values = (t: string, pending?: Parameters<typeof extractConstraints>[2]) => extractConstraints(t, REF, pending);
const replyText = (r: ParseResult) => (r.kind === 'reply' ? r.message.text : r.kind === 'commands' ? r.acknowledgement?.text ?? '' : '');
const ask = (text: string, ctx: Record<string, unknown> = {}) => setup(ctx as never, undefined, 'direct').service.parseInbound(msg({ text, visibility: 'private', spaceId: 'dm-mason' }));
const mason = { memberId: 'alex', name: 'Alex', shared: ['is free Nov 14-17'], missing: ['budget'] };

describe('weekend phrases are read by rule', () => {
  it('"this weekend" and "next weekend" are Friday to Sunday', () => {
    expect(parseDateWindows('this weekend', REF)).toEqual([{ start: '2026-10-16', end: '2026-10-18' }]);
    expect(parseDateWindows('next weekend', REF)).toEqual([{ start: '2026-10-23', end: '2026-10-25' }]);
  });
  it('"I\'m free next weekend" needs no language model', () => {
    expect(values("I'm free next weekend").map((e) => e.value.field)).toEqual(['availability']);
  });
});

describe('places named in a list', () => {
  it('"Chapel Hill, 2 nights, Washington DC, I have a car" has a destination', () => {
    const v = values("I'm leaving from Chapel Hill, 2 nights, Washington DC, I have a car").map((e) => e.value);
    expect(v).toContainEqual({ field: 'region', value: 'Washington DC' });
    expect(v).toContainEqual({ field: 'origin', value: 'Chapel Hill' });
  });
  it('a state after a city is not a destination', () => {
    expect(values("I'm leaving from Chapel Hill, NC, 2 nights, I have a car").some((e) => e.value.field === 'region')).toBe(false);
  });
  it('drops a leading "the"', () => {
    expect(values('leaving from Durham, 3 nights, the coast, I have a car').map((e) => e.value)).toContainEqual({ field: 'region', value: 'coast' });
  });
});

describe('answers that were saved wrongly', () => {
  it('"mostly food" is food', () => {
    expect(values('mostly food', 'preferences').map((e) => e.value)).toEqual([{ field: 'preferences', value: ['food'] }]);
  });
  it.each(['tell mason to hurry up', 'start over', 'ask mason for his dates'])('"%s" is not a liking or a place', (t) => {
    expect(values(t, 'preferences')).toEqual([]);
    expect(values(t, 'origin')).toEqual([]);
  });
  it('a total under $20 is asked about, not locked in', () => {
    const [b] = values('my max is $5');
    expect(b!.value).toEqual({ field: 'budget', value: 500 });
    expect(b!.hedged).toBe(true);
    expect(values('my max is $300')[0]!.hedged).toBe(false);
  });
});

describe('chat replies', () => {
  it('"tell Mason to hurry up" nudges like asking for options', async () => {
    const r = await ask('tell alex to hurry up', { others: [mason] });
    expect(r.kind === 'command' ? r.command.action.kind : r.kind === 'commands' ? r.commands[0]?.action.kind : r.kind).toBe('request_plans');
  });
  it('"start over" says what can be done instead', async () => {
    expect(replyText(await ask('start over'))).toMatch(/can't clear a trip yet/);
  });
  it.each(['cancel', 'never mind', 'nvm'])('"%s" is answered kindly', async (t) => {
    expect(replyText(await ask(t))).toMatch(/No worries/);
  });
  it('a generic place keeps its small letters', async () => {
    const t = setup({} as never, () => ({ intent: 'constraints', items: [{ field: 'region', text: 'the beach' }] }), 'direct');
    const r = await t.service.parseInbound(msg({ text: 'I want to go to the beach', visibility: 'private', spaceId: 'dm-mason' }));
    expect(replyText(r)).toMatch(/the beach/);
    expect(replyText(r)).not.toMatch(/Beach/);
  });
  it('"what did Alex say?" includes what they said about the shared basics', async () => {
    const r = await ask('what did alex say?', { others: [{ ...mason, shared: ['wants 3 nights', 'is free Nov 14-17'] }] });
    expect(replyText(r)).toMatch(/wants 3 nights/);
  });
});
