import { describe, expect, it } from 'vitest';
import type { ParseResult } from '../../src/conversation/contracts-local.js';
import { msg, setup } from './helpers.js';

const others = [{ memberId: 'alex', name: 'Alex', shared: [], missing: [] }];
const ask = (text: string) => setup({ others } as never, undefined, 'direct').service.parseInbound(msg({ text, visibility: 'private', spaceId: 'dm-mason' }));
const actions = (r: ParseResult) => (r.kind === 'command' ? [r.command.action] : r.kind === 'commands' ? r.commands.map((c) => c.action) : []);
const pay = async (text: string) => actions(await ask(text)).find((a) => a.kind === 'fund_pay');
const replyText = (r: ParseResult) => (r.kind === 'reply' ? r.message.text : '');

describe('paying into the simulated fund: how people actually type it', () => {
  it.each([
    'pay my share', "I'll pay my part now", 'let me pay my share', 'lemme pay my share', 'can I pay my share?', 'i want to pay my share',
    'send my share', 'time to pay my share', 'ok pay my share please', 'I should pay my portion', 'pay up', 'I want to contribute', 'chip in',
  ])('"%s" starts a payment of their own share', async (t) => {
    expect(await pay(t)).toEqual({ kind: 'fund_pay' });
  });

  it.each([['chip in 100', 100], ['chip in $50', 50], ['put in $60', 60], ["I'll pay 75 dollars", 75], ['let me chip in 20 bucks', 20], ['pay $5000000', 5000000]])('"%s" is a payment of that amount', async (t, dollars) => {
    expect(await pay(t as string)).toEqual({ kind: 'fund_pay', dollars });
  });

  it.each([["cover Alex's share", {}], ["pay Alex's share", {}], ['can I pay for Alex too?', {}], ['pay for Alex', {}], ["I'll cover Alex", {}]])('"%s" covers someone else', async (t, extra) => {
    expect(await pay(t as string)).toEqual({ kind: 'fund_pay', forName: 'Alex', ...(extra as object) });
  });

  it.each([['put in $60 for Alex', 60], ['chip in 30 for Alex', 30], ["pay $40 toward Alex's share", 40]])('"%s" covers an amount for someone', async (t, dollars) => {
    expect(await pay(t as string)).toEqual({ kind: 'fund_pay', dollars, forName: 'Alex' });
  });

  it('"pay <number>" is never read as a budget, so it cannot cancel an approved plan', async () => {
    const found = actions(await ask('pay $5000000'));
    expect(found.some((a) => a.kind === 'update_constraint')).toBe(false);
    for (const real of ['I can pay 300 total', 'I can only pay 300', 'I can spend 300']) expect(actions(await ask(real)).some((a) => a.kind === 'update_constraint')).toBe(true);   // a real budget statement still works
  });

  it('"paid" and "I already paid" explain that only the fund counts', async () => {
    for (const t of ['paid', 'I paid', 'I already paid my share']) expect(replyText(await ask(t))).toMatch(/Say "pay my share"/);
  });

  it('"how do I pay?" says how', async () => {
    expect(replyText(await ask('how do I pay?'))).toMatch(/Just say "pay my share"/);
  });

  it('does not treat ordinary talk as a payment', async () => {
    for (const t of ['pay attention', 'I like to send postcards', 'what should I pack']) expect(await pay(t)).toBeUndefined();
  });
});
