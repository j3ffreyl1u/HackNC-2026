import { describe, expect, it } from 'vitest';
import type { ActionableItem, ParseResult, TripCommand } from '../../src/conversation/contracts-local.js';
import { validateIntent } from '../../src/conversation/intent.js';
import { msg, setup } from './helpers.js';

const cmds = (r: ParseResult): TripCommand[] => (r.kind === 'command' ? [r.command] : r.kind === 'commands' ? r.commands : []);
const text = (r: ParseResult) => (r.kind === 'reply' ? r.message.text : r.kind === 'commands' ? r.clarification?.text ?? '' : '');

const pick1: ActionableItem = { kind: 'select', candidateId: 'dm-r12-gem-opt-2', revision: 12, description: 'DC food and museums' };
const pick2: ActionableItem = { kind: 'select', candidateId: 'dm-r12-gem-opt-1', revision: 12, description: 'A weekend in DC' };
const accept: ActionableItem = { kind: 'accept', candidateId: 'dm-r12-gem-opt-2', revision: 12, description: 'DC food and museums' };
const first = { kind: 'select_candidate', candidateId: 'dm-r12-gem-opt-2', revision: 12 };
const second = { kind: 'select_candidate', candidateId: 'dm-r12-gem-opt-1', revision: 12 };

describe('picking an option in everyday words', () => {
  const asPick = async (words: string, ctx = { actionable: [pick1, pick2] }) => {
    const { service } = setup(ctx, undefined, 'direct');
    return service.parseInbound(msg({ text: words, visibility: 'private', spaceId: 'dm-mason' }));
  };

  it.each([
    'option 1', 'Option 1', 'the first one', 'first', '1', '#1', 'number 1', 'option one', "let's do option 1", "let's go with the first one",
    "I'll take 1", "I'll take the first one", 'go with option 1', 'I pick the first one', 'I vote for option 1', 'option 1 please', 'the 1st one', 'plan 1', 'I like option 1', 'I want option 1',
  ])('"%s" picks the first option', async (words) => {
    expect(cmds(await asPick(words))[0]?.action, words).toEqual(first);
  });

  it.each(['option 2', 'the second one', 'second', '2', 'number 2', "let's do option 2", "I'll take the second one", 'option two', 'the 2nd one', 'I like option 2 better'])('"%s" picks the second option', async (words) => {
    expect(cmds(await asPick(words))[0]?.action, words).toEqual(second);
  });

  it('says what is open when the number does not exist, without internal ids', async () => {
    const r = await asPick('option 3');
    expect(cmds(r)).toEqual([]);
    expect(text(r)).toMatch(/1\. DC food and museums; 2\. A weekend in DC/);
    expect(text(r)).not.toMatch(/dm-r12/);
  });

  it('does not treat "2 nights", "I like food" or "1 night" as a pick', async () => {
    for (const words of ['2 nights', 'I like food', 'just 1 night', 'my max is 2', 'I have 1 car']) {
      expect(cmds(await asPick(words)).some((c) => c.action.kind === 'select_candidate'), words).toBe(false);
    }
  });

  it('a bare number is the answer to a pending question, not a pick', async () => {
    const { service } = setup({ actionable: [pick1, pick2], pendingQuestion: { field: 'duration' } }, undefined, 'direct');
    const r = await service.parseInbound(msg({ text: '2', visibility: 'private', spaceId: 'dm-mason' }));
    expect(cmds(r).some((c) => c.action.kind === 'select_candidate')).toBe(false);
  });

  it('picks nothing when no option is open', async () => {
    const r = await asPick('option 1', { actionable: [] });
    expect(cmds(r).some((c) => c.action.kind === 'select_candidate')).toBe(false);
  });

  it('never accepts: choosing is not agreeing to pay', async () => {
    const r = await asPick('option 1', { actionable: [accept] });
    expect(cmds(r).some((c) => c.action.kind === 'accept_candidate')).toBe(false);
  });
});

describe('the Gemini intent list has a pick intent', () => {
  it('validates a pick with a whole-number choice and nothing else', () => {
    expect(validateIntent({ intent: 'pick', choice: 2 })).toEqual({ intent: 'pick', choice: 2 });
    expect(validateIntent({ intent: 'pick', choice: '1' })).toEqual({ intent: 'pick', choice: 1 });
    for (const bad of [{ intent: 'pick' }, { intent: 'pick', choice: 0 }, { intent: 'pick', choice: 2.5 }, { intent: 'pick', choice: 99 }, { intent: 'pick', choice: 'first' }]) {
      expect(validateIntent(bad).intent).toBe('clarify');
    }
  });

  it('a pick from the model selects that option', async () => {
    const { service } = setup({ actionable: [pick1, pick2] }, () => ({ intent: 'pick', choice: 2 }), 'direct');
    const r = await service.parseInbound(msg({ text: 'ooh the DC one with the farmers market sounds fun', visibility: 'private', spaceId: 'dm-mason' }));
    expect(cmds(r)[0]?.action).toEqual(second);
  });

  it('a pick from the model with nothing open does nothing', async () => {
    const { service } = setup({ actionable: [] }, () => ({ intent: 'pick', choice: 1 }), 'direct');
    const r = await service.parseInbound(msg({ text: 'the first one sounds nice', visibility: 'private', spaceId: 'dm-mason' }));
    expect(cmds(r)).toEqual([]);
  });
});

describe('"I\'m in" with several things open', () => {
  it('asks which one in plain words, with no internal ids and no version numbers', async () => {
    const { service } = setup({ actionable: [pick1, pick2] }, undefined, 'direct');
    const r = await service.parseInbound(msg({ text: "I'm in", visibility: 'private', spaceId: 'dm-mason' }));
    expect(cmds(r)).toEqual([]);
    expect(text(r)).toMatch(/more than one/);
    expect(text(r)).toMatch(/1\. DC food and museums/);
    expect(text(r)).toMatch(/2\. A weekend in DC/);
    expect(text(r)).toMatch(/"option 1"/);
    expect(text(r)).not.toMatch(/dm-r12|gem-opt|\bv\d+\b|<id>/);
  });
});

describe('"I\'m in" with a pick and an acceptance both open', () => {
  it('does not tell them to say "option N" for something they would be accepting', async () => {
    const { service } = setup({ actionable: [pick1, { ...accept, candidateId: 'other', description: 'Another plan' }] }, undefined, 'direct');
    const r = await service.parseInbound(msg({ text: "I'm in", visibility: 'private', spaceId: 'dm-mason' }));
    expect(cmds(r)).toEqual([]);
    expect(text(r)).toMatch(/more than one thing/);
    expect(text(r)).not.toMatch(/"option 1"/);
    expect(text(r)).not.toMatch(/\bv\d+\b/);
  });
});

describe('tapbacks that arrive as text', () => {
  const liked = (words: string, ctx = { actionable: [pick1, pick2] }, mode: 'direct' | 'group' = 'direct') => {
    const { service } = setup(ctx, undefined, mode);
    return service.parseInbound(msg({ text: words, ...(mode === 'direct' ? { visibility: 'private' as const, spaceId: 'dm-mason' } : {}) }));
  };

  it('Liked "Option 1: …" picks that option (curly quotes too)', async () => {
    expect(cmds(await liked('Liked “Option 1: DC food and museums, Nov 14-16.”'))[0]?.action).toEqual(first);
    expect(cmds(await liked('Loved "Option 2: A weekend in DC, Nov 14-16."'))[0]?.action).toEqual(second);
  });

  it('finds the option by its name when the quote does not start with "Option N"', async () => {
    expect(cmds(await liked('Liked “A weekend in DC, Nov 14-16. In DC: Old Town, Central Market.”'))[0]?.action).toEqual(second);
  });

  it('a like on the single plan awaiting acceptance is an acceptance of that exact version', async () => {
    expect(cmds(await liked('Liked “DC food and museums is the pick. Choosing it isn\'t agreeing to pay.”', { actionable: [accept] }))[0]?.action).toEqual({ kind: 'accept_candidate', candidateId: 'dm-r12-gem-opt-2', revision: 12 });
  });

  it('a like on something that is not a proposal is ignored, never answered with "I didn\'t catch that"', async () => {
    const r = await liked('Liked “Hey! Want to plan a trip?”');
    expect(r.kind).toBe('ignored');
  });

  it('negative and neutral tapbacks record nothing', async () => {
    for (const words of ['Disliked “Option 1: DC food and museums”', 'Laughed at “Option 1: DC food and museums”', 'Emphasized “Option 1: DC food and museums”', 'Questioned “Option 1: DC food and museums”']) {
      const r = await liked(words);
      expect(cmds(r), words).toEqual([]);
      expect(r.kind, words).toBe('ignored');
    }
  });

  it('a typed thumbs up counts as a yes for the single plan awaiting acceptance, and is ignored when nothing is open', async () => {
    expect(cmds(await liked('👍', { actionable: [accept] }))[0]?.action.kind).toBe('accept_candidate');
    expect((await liked('👍', { actionable: [] })).kind).toBe('ignored');
  });

  it('a typed thumbs up with two options open asks which, and picks nothing', async () => {
    const r = await liked('👍');
    expect(cmds(r)).toEqual([]);
    expect(text(r)).toMatch(/more than one/);
  });
});
