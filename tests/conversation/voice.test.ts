import { describe, expect, it } from 'vitest';
import { acceptPolished, createGeminiVoice, shouldPolish } from '../../src/conversation/voice.js';

const reply = (text: string) => async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

describe('what may be reworded', () => {
  it.each(['Got it: leaving from Chapel Hill. Tell me if I got anything wrong.', 'Where are you all leaving from?', 'Great, 3 nights it is.'])('plain chat "%s" may be', (t) => expect(shouldPolish(t)).toBe(true));
  it.each([
    'Got it: your max is $250 (just between us). Tell me if I got anything wrong.',
    'The full plan is here: https://example.com',
    'Option 1: Blue Ridge\nNov 14-16 · about $130-$381 each',
    'ok',
    'x'.repeat(300),
  ])('"%s" is never reworded', (t) => expect(shouldPolish(t)).toBe(false));
});

describe('a rewrite is only used if it keeps every fact', () => {
  const original = 'Got it: leaving from Chapel Hill. Tell me if I got anything wrong.';
  it('accepts a friendlier rewrite that keeps the names and numbers', () => {
    expect(acceptPolished(original, 'Chapel Hill, noted. Shout if that is off.')).toBe('Chapel Hill, noted. Shout if that is off.');
  });
  it.each([
    ['drops a place', 'Noted, leaving from there. Shout if that is off.'],
    ['adds an amount', 'Chapel Hill, noted. That should be about $200 each.'],
    ['uses an em dash', 'Chapel Hill, noted — shout if that is off.'],
    ['turns a statement into a question', 'Is it Chapel Hill?'],
    ['stacks exclamations', 'Chapel Hill! Noted! Great!'],
    ['rambles', 'Chapel Hill, noted. '.repeat(10)],
    ['is the same text', original],
    ['is empty', ''],
  ])('rejects a rewrite that %s', (_why, candidate) => expect(acceptPolished(original, candidate)).toBeUndefined());
  it('keeps quoted phrases and dates exactly', () => {
    expect(acceptPolished('Say "show us options" when you are free Nov 14-17.', 'Say "show us options" once you are free Nov 14-17.')).toBeDefined();
    expect(acceptPolished('Say "show us options" when you are free Nov 14-17.', 'Say show us options when you are free Nov 14-17.')).toBeUndefined();
    expect(acceptPolished('Say "show us options" when you are free Nov 14-17.', 'Say "show us options" when you are free Nov 15-17.')).toBeUndefined();
  });
});

describe('the Gemini voice', () => {
  const voice = (text: string, errors: unknown[] = []) => createGeminiVoice({ apiKey: 'k', model: 'm', fetchImpl: reply(text) as never, onError: (e) => errors.push(e) });
  it('returns the rewrite when it is safe', async () => {
    expect(await voice('Chapel Hill, noted. Shout if that is off.').polish('Got it: leaving from Chapel Hill. Tell me if I got anything wrong.')).toBe('Chapel Hill, noted. Shout if that is off.');
  });
  it('falls back to the original when the rewrite loses a fact', async () => {
    const original = 'Got it: leaving from Chapel Hill. Tell me if I got anything wrong.';
    expect(await voice('Noted, thanks.').polish(original)).toBe(original);
  });
  it('falls back to the original on an HTTP error, without throwing', async () => {
    const errors: unknown[] = [];
    const failing = createGeminiVoice({ apiKey: 'k', model: 'm', fetchImpl: (async () => new Response('no', { status: 500 })) as never, onError: (e) => errors.push(e) });
    expect(await failing.polish('Where are you all leaving from?')).toBe('Where are you all leaving from?');
    expect(errors).toHaveLength(1);
  });
  it('never even calls the model for a message with money in it', async () => {
    let calls = 0;
    const counting = createGeminiVoice({ apiKey: 'k', model: 'm', fetchImpl: (async () => { calls += 1; return reply('x')(); }) as never });
    const text = 'Got it: your max is $250 (just between us). Tell me if I got anything wrong.';
    expect(await counting.polish(text)).toBe(text);
    expect(calls).toBe(0);
  });
});

describe('cut-off or unfinished replies are never used', () => {
  const original = 'Great, 3 nights it is.';
  it('rejects text that stops mid-sentence', () => expect(acceptPolished(original, 'Awesome, 3')).toBeUndefined());
  it('ignores a reply the model did not finish', async () => {
    const unfinished = async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Perfect, 3 nights it is.' }] } }] }), { status: 200 });
    expect(await createGeminiVoice({ apiKey: 'k', model: 'm', fetchImpl: unfinished as never }).polish(original)).toBe(original);
  });
});
