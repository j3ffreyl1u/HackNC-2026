import { describe, expect, it } from 'vitest';
import { parseDueDate } from '../../src/conversation/dates.js';
import { msg, setup } from './helpers.js';

const ref = '2026-10-01T12:00:00Z';
describe('parseDueDate', () => {
  it.each([
    ['2026-10-15', '2026-10-15'], ['Oct 15', '2026-10-15'], ['October 15th', '2026-10-15'], ['oct. 15', '2026-10-15'],
    ['15 Oct', '2026-10-15'], ['10/15', '2026-10-15'], ['10/15/2026', '2026-10-15'], ['Sept 3', '2026-09-03'], ['Oct 15, 2027', '2027-10-15'],
  ])('%s -> %s', (i, o) => expect(parseDueDate(i, ref)).toBe(o));
  it('rolls long-past dates into next year but keeps recent ones', () => {
    expect(parseDueDate('Jan 5', ref)).toBe('2027-01-05');
    expect(parseDueDate('Sep 25', ref)).toBe('2026-09-25');
  });
  it.each(['Oct 32', 'Feb 30', 'Foo 15', '13/40', 'soon', 'Octopus 5', ''])('rejects %s', (i) => expect(parseDueDate(i, ref)).toBeNull());
});

describe('natural due dates in the fallback', () => {
  it('"add electricity $144 due Oct 15" is one 14,400-cent command, no AI', async () => {
    const { service, model } = setup();
    const r = await service.parseInbound(msg({ text: 'add electricity $144 due Oct 15' }));
    expect(r.kind === 'command' && r.command.payload).toMatchObject({ kind: 'add_bill', amountCents: 14400, dueDate: '2026-10-15', recipientId: 'duke-energy' });
    expect(model.calls).toHaveLength(0);
  });
  it('an unreadable date asks instead of guessing', async () => {
    const { service } = setup();
    expect((await service.parseInbound(msg({ text: 'add electricity $144 due whenever' }))).kind).toBe('reply');
  });
});
