import { describe, expect, it } from 'vitest';
import type { ParseResult } from '../../src/conversation/contracts-local.js';
import { msg, setup } from './helpers.js';

const dm = (text: string) => msg({ text, visibility: 'private', spaceId: 'dm-mason' });
const ackText = (r: ParseResult) => (r.kind === 'commands' ? r.acknowledgement?.text ?? '' : '');

describe('when the language helper is down for part of a message', () => {
  it('what the rules understood is saved and the person is told which part was not read', async () => {
    const { service } = setup({}, () => ({ intent: 'unavailable' }) as never, 'direct');
    const r = await service.parseInbound(dm("I'm leaving from Raleigh, and something about a farmers market vibe"));
    expect(r.kind).toBe('commands');
    expect(ackText(r)).toMatch(/leaving from Raleigh/);
    expect(ackText(r)).toMatch(/language helper isn't answering/);
    expect(ackText(r)).toMatch(/farmers market vibe/);
  });
  it('a fully understood message is not accused of anything', async () => {
    const { service } = setup({}, () => ({ intent: 'unavailable' }) as never, 'direct');
    expect(ackText(await service.parseInbound(dm("I'm leaving from Raleigh")))).not.toMatch(/language helper/);
  });
  it('in a group nothing extra is said', async () => {
    const { service } = setup({}, () => ({ intent: 'unavailable' }) as never);
    const r = await service.parseInbound(msg({ text: "I'm leaving from Raleigh, and something about a farmers market vibe" }));
    expect(ackText(r)).not.toMatch(/language helper/);
  });
});
