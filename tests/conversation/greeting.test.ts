import { describe, expect, it } from 'vitest';
import type { ParseResult, TripCommand } from '../../src/conversation/contracts-local.js';
import { msg, setup } from './helpers.js';

const cmds = (r: ParseResult): TripCommand[] => (r.kind === 'command' ? [r.command] : r.kind === 'commands' ? r.commands : []);
const text = (r: ParseResult) => (r.kind === 'reply' ? r.message.text : r.kind === 'commands' ? r.clarification?.text ?? '' : '');
const dm = (words: string) => msg({ text: words, visibility: 'private', spaceId: 'dm-mason' });
const GREETINGS = ['Hello', 'hello', 'Hello!', 'Hi', 'hi', 'Hey', 'hey', 'Hey there', 'Hi there!', 'Hello there', 'Good morning', 'good evening', 'Yo', 'Sup', 'Howdy', 'Hola', "What's up", 'Hi Alex', 'Hello Alex!', 'Hi everyone', 'Hey guys', 'Thanks', 'Thank you!', 'lol', 'hmm', 'Hmm', 'um', 'Test', 'testing'];

describe('a greeting or filler word is never a place', () => {
  for (const pending of [undefined, 'origin', 'region'] as const) {
    describe(pending ? `while the bot is waiting for the ${pending}` : 'with no question open', () => {
      it.each(GREETINGS)('"%s" records nothing and is not read as a place', async (words) => {
        const { service } = setup(pending ? { pendingQuestion: { field: pending } } : {}, undefined, 'direct');
        const r = await service.parseInbound(dm(words));
        expect(cmds(r), words).toEqual([]);
        expect(text(r), words).not.toMatch(/where you're leaving from, or where you want to go|leaving from \w+\.|Got it/i);
      });
    });
  }

  it('a greeting in the middle of planning gets the open question back, not an invitation to start over', async () => {
    const { service } = setup({ pendingQuestion: { field: 'origin' } }, undefined, 'direct');
    const r = await service.parseInbound(dm('Hello'));
    expect(text(r)).toMatch(/leaving from/i);
    expect(text(r)).not.toMatch(/let's plan a trip/i);
  });

  it('a first greeting still offers to start a trip', async () => {
    const { service } = setup({}, undefined, 'direct');
    expect(text(await service.parseInbound(dm('Hello')))).toMatch(/let's plan a trip/i);
  });

  it('in a group, greetings between friends get no reply at all', async () => {
    const { service } = setup({ pendingQuestion: { field: 'origin' } });
    for (const words of ['Hello', 'hey guys', 'Hi Alex', 'lol']) {
      const r = await service.parseInbound(msg({ text: words }));
      expect(r.kind, words).toBe('ignored');
    }
  });
});

describe('other words that are not places are not read as one while the bot waits for a place', () => {
  it.each(['help', 'Help', 'cancel', 'Cancel', 'never mind', 'Nevermind', 'stop', 'idk', 'huh', 'what', 'why', 'nothing', 'menu', 'options', 'skip', 'later', 'sorry', 'wait'])('"%s"', async (words) => {
    for (const field of ['origin', 'region'] as const) {
      const { service } = setup({ pendingQuestion: { field } }, undefined, 'direct');
      const r = await service.parseInbound(dm(words));
      expect(cmds(r).filter((c) => c.action.kind === 'update_constraint'), `${words} / ${field}`).toEqual([]);
    }
  });
});

describe('real places are still understood', () => {
  it.each(['Raleigh', 'Chapel Hill', 'New York City', 'Boone'])('"%s" answers the origin question', async (place) => {
    const { service } = setup({ pendingQuestion: { field: 'origin' } }, undefined, 'direct');
    const r = await service.parseInbound(dm(place));
    const update = cmds(r)[0]?.action;
    expect(update).toMatchObject({ kind: 'update_constraint', update: { field: 'origin' } });
  });

  it('a bare capitalized place with no question open still asks whether it is the origin or the destination', async () => {
    const { service } = setup({}, undefined, 'direct');
    expect(text(await service.parseInbound(dm('Boone')))).toMatch(/where you're leaving from, or where you want to go/);
  });

  it('a greeting that also says something is still read: "Hi, I\'m leaving from Raleigh"', async () => {
    const { service } = setup({}, undefined, 'direct');
    const r = await service.parseInbound(dm("Hi, I'm leaving from Raleigh"));
    expect(cmds(r)[0]?.action).toMatchObject({ kind: 'update_constraint', update: { field: 'origin' } });
  });
});
