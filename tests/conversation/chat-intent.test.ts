import { describe, expect, it } from 'vitest';
import { extractConstraints } from '../../src/conversation/constraints.js';
import { safeChatAnswer, validateIntent } from '../../src/conversation/intent.js';
import type { ParseResult } from '../../src/conversation/contracts-local.js';
import { msg, setup } from './helpers.js';

const replyText = (r: ParseResult) => (r.kind === 'reply' ? r.message.text : '');

describe('safeChatAnswer', () => {
  const facts = 'Mason has said: is free Nov 10-25. Mason has not given: a maximum budget.';
  it('lets a short, friendly answer through', () => {
    expect(safeChatAnswer('Mason is free Nov 10-25, but has not given a budget yet.', facts)).not.toBeNull();
  });
  it.each([
    ['a dollar amount', 'Mason said his max is $400.'],
    ['an invented number', 'Mason is free for 5 days.'],
    ['an em dash', 'Mason is on it — almost done.'],
    ['markdown', 'Mason is **almost** done.'],
    ['the old stiff line', "Got it. Shout if that's off!"],
    ['a long answer', 'Sure. Yes. Okay. Right. Fine.'],
    ['nothing', '   '],
  ])('rejects %s', (_label, answer) => {
    expect(safeChatAnswer(answer, facts)).toBeNull();
  });
});

describe('the chat intent', () => {
  it('is validated like any other model output', () => {
    expect(validateIntent({ intent: 'chat', answer: 'Not yet!' })).toEqual({ intent: 'chat', answer: 'Not yet!' });
    expect(validateIntent({ intent: 'chat' })).toEqual({ intent: 'clarify' });
  });
  it('answers a casual question in a one-on-one chat with the checked model reply', async () => {
    const t = setup({ others: [{ memberId: 'alex', name: 'Alex', shared: ['is free Nov 10-25'], missing: ['budget'] }] }, () => ({ intent: 'chat', answer: 'Alex is free Nov 10-25 and still owes me a budget.' }), 'direct');
    const r = await t.service.parseInbound(msg({ text: 'so how is alex doing with all this', visibility: 'private' }));
    expect(replyText(r)).toBe('Alex is free Nov 10-25 and still owes me a budget.');
    expect(JSON.stringify(t.model.calls?.[0] ?? '')).toBeDefined();
  });
  it('falls back to plain help when the model answer breaks the rules', async () => {
    const t = setup({}, () => ({ intent: 'chat', answer: 'Alex has $400 to spend.' }), 'direct');
    const r = await t.service.parseInbound(msg({ text: 'so how is alex doing with all this', visibility: 'private' }));
    expect(replyText(r)).toMatch(/didn't quite catch that|Not sure/i);
  });
  it('stays quiet in a group chat', async () => {
    const t = setup({}, () => ({ intent: 'chat', answer: 'Sounds fun!' }));
    const r = await t.service.parseInbound(msg({ text: 'lol this is fun' }));
    expect(r.kind).toBe('ignored');
  });
});

describe('reactions are not likings', () => {
  it.each(['Everything looks good', 'sounds great', 'how does this work', 'that works', 'ok', 'cool', 'lol this is fun', 'haha nice'])('"%s" while asked what they like', (t) => {
    expect(extractConstraints(t, '2026-10-11T12:00:00Z', 'preferences')).toEqual([]);
  });
  it('still reads a real answer', () => {
    expect(extractConstraints('historical monuments and good food', '2026-10-11T12:00:00Z', 'preferences').map((e) => e.value)).toEqual([{ field: 'preferences', value: ['historical monuments', 'good food'] }]);
  });
});

describe('reactions are not places', () => {
  it.each(['Everything looks good', 'lol this is fun', 'how does this work', 'sounds good', 'yes that works'])('"%s" while asked where', (q) => {
    expect(extractConstraints(q, '2026-10-11T12:00:00Z', 'region')).toEqual([]);
    expect(extractConstraints(q, '2026-10-11T12:00:00Z', 'origin')).toEqual([]);
  });
  it('still reads real places, including ones with a common word in the name', () => {
    expect(extractConstraints('Great Smoky Mountains', '2026-10-11T12:00:00Z', 'region').map((e) => e.value)).toEqual([{ field: 'region', value: 'Great Smoky Mountains' }]);
    expect(extractConstraints('Asheville', '2026-10-11T12:00:00Z', 'region').map((e) => e.value)).toEqual([{ field: 'region', value: 'Asheville' }]);
  });
});

describe('likings are the thing liked, not the verb', () => {
  it('"I want to go to museums and eat yummy food"', () => {
    expect(extractConstraints('I want to go to museums and eat yummy food', '2026-10-11T12:00:00Z', 'preferences').map((e) => e.value)).toEqual([{ field: 'preferences', value: ['museums', 'yummy food'] }]);
  });
});
