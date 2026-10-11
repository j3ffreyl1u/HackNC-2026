import { describe, expect, it } from 'vitest';
import { parseDateWindows } from '../../src/conversation/dates.js';
import { validateIntent } from '../../src/conversation/intent.js';

const REF = '2026-10-14T12:00:00Z';

describe('fixes found by scripted chat loops', () => {
  it('"the weekend of Nov 21" is the Friday to Sunday around that Saturday', () => {
    expect(parseDateWindows('free the weekend of nov 21', REF)).toEqual([{ start: '2026-11-20', end: '2026-11-22' }]);
  });
  it('"somewhere warm" is a liking, not a destination', () => {
    expect(validateIntent({ intent: 'constraints', items: [{ field: 'region', text: 'Somewhere warm' }] }))
      .toEqual({ intent: 'constraints', items: [{ field: 'preferences', value: ['warm weather'] }] });
    expect(validateIntent({ intent: 'constraints', items: [{ field: 'region', text: 'anywhere' }] })).toEqual({ intent: 'clarify' });
  });
});

describe('small talk after the trip is set', () => {
  it('"cool see u there" and "im in too" are not misses', async () => {
    const { setup, msg } = await import('./helpers.js');
    const ask = (text: string, ctx: Record<string, unknown> = {}) => setup(ctx as never, undefined, 'direct').service.parseInbound(msg({ text, visibility: 'private', spaceId: 'dm-mason' }));
    const text = (r: { kind: string; message?: { text: string } }) => (r.kind === 'reply' ? r.message!.text : '');
    expect(text(await ask('cool see u there') as never)).toMatch(/See you there|Sounds fun/);
    expect(text(await ask('im in too') as never)).not.toMatch(/didn't quite catch/);
  });
});

describe('"wanna go <place>" without "to"', () => {
  it('reads the place', async () => {
    const { extractConstraints } = await import('../../src/conversation/constraints.js');
    const region = (t: string) => extractConstraints(t, REF).map((e) => e.value).find((v) => v.field === 'region');
    expect(region('im in raleigh, wanna go asheville, like 2 nights')).toEqual({ field: 'region', value: 'Asheville' });
    expect(region('we should go hiking this weekend')).toBeUndefined();
    expect(region('wanna go eat after')).toBeUndefined();
    expect(region('lets go with the cheaper one')).toBeUndefined();
  });
});

describe('picking an option by its name', () => {
  it('"i like the cabin" picks the one option with that word, not a liking', async () => {
    const { setup, msg } = await import('./helpers.js');
    const options = [
      { kind: 'select', candidateId: 'c1', revision: 1, description: 'State park and small-town weekend' },
      { kind: 'select', candidateId: 'c2', revision: 1, description: 'Mountain cabin weekend' },
    ];
    const r = await setup({ actionable: options } as never, undefined, 'direct').service.parseInbound(msg({ text: 'i like the cabin', visibility: 'private', spaceId: 'dm-mason' }));
    expect(JSON.stringify(r)).toMatch(/select_candidate/);
    expect(JSON.stringify(r)).toMatch(/c2/);
  });
});

describe('"help" is a request for the menu, not a miss', () => {
  it('replies with what the assistant can do', async () => {
    const { setup, msg } = await import('./helpers.js');
    const r = await setup({} as never, undefined, 'direct').service.parseInbound(msg({ text: 'help', visibility: 'private', spaceId: 'dm-mason' }));
    expect(JSON.stringify(r)).toMatch(/Happy to help/);
  });
});

describe('a few more everyday messages', () => {
  it('"hold on" and "add it to my calendar" are answered, not missed', async () => {
    const { setup, msg } = await import('./helpers.js');
    const ask = async (text: string) => JSON.stringify(await setup({} as never, undefined, 'direct').service.parseInbound(msg({ text, visibility: 'private', spaceId: 'dm-mason' })));
    expect(await ask('hold on')).toMatch(/No rush/);
    expect(await ask('add it to my calendar')).toMatch(/can't add things to a calendar/);
  });
});
