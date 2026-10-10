import { describe, expect, it } from 'vitest';
import { msg, setup } from './helpers.js';

const proposal = (id: string, v = 1) => ({ proposalId: id, proposalVersion: v, description: `Contribution ${id}` });

describe('bill entry', () => {
  it('turns the fallback add into exactly one 14,400-cent command', async () => {
    const { service, model } = setup();
    const r = await service.parseInbound(msg({ text: 'add electricity $144 due 2026-10-15' }));
    expect(r).toMatchObject({ kind: 'command', command: { actorId: 'mason', householdId: 'demo-house', sourceEventId: 'e1',
      payload: { kind: 'add_bill', amountCents: 14400, title: 'electricity', dueDate: '2026-10-15', recipientId: 'duke-energy', cycleId: '2026-10' } } });
    expect(model.calls).toHaveLength(0);
  });
  it('parses cents with decimals, not floats', async () => {
    const { service } = setup();
    const r = await service.parseInbound(msg({ text: 'add electricity $144.10 due 2026-10-15' }));
    expect(r.kind === 'command' && r.command.payload).toMatchObject({ amountCents: 14410 });
  });
  it('asks for clarification on unknown payee and creates no command', async () => {
    const { service } = setup();
    const r = await service.parseInbound(msg({ text: 'add internet $60 due 2026-10-15' }));
    expect(r.kind).toBe('reply');
  });
  it.each(['add electricity $abc due 2026-10-15', 'add electricity $1.234 due 2026-10-15', 'add electricity $0 due 2026-10-15', 'add electricity $144 due 2026-13-45'])('rejects unclear input: %s', async (text) => {
    const { service } = setup();
    expect((await service.parseInbound(msg({ text }))).kind).toBe('reply');
  });
  it('model output with an unclear amount yields a clarification', async () => {
    const { service } = setup({}, () => ({ intent: 'add_bill', amount: 'about a hundred', title: 'electricity', dueDate: '2026-10-15' }));
    expect((await service.parseInbound(msg({ text: 'electricity is like a hundred bucks' }))).kind).toBe('reply');
  });
  it('model-extracted bill becomes a command after validation', async () => {
    const { service } = setup({}, () => ({ intent: 'add_bill', amount: '144', title: 'electricity', dueDate: '2026-10-15' }));
    const r = await service.parseInbound(msg({ text: 'electric bill was 144, due the 15th' }));
    expect(r.kind === 'command' && r.command.payload).toMatchObject({ kind: 'add_bill', amountCents: 14400 });
  });
  it('garbage model output never yields a command', async () => {
    const { service } = setup({}, () => 'DROP TABLE');
    expect((await service.parseInbound(msg({ text: 'hello there' }))).kind).toBe('reply');
  });
  it('summary maps to get_summary for the context cycle', async () => {
    const { service } = setup();
    const r = await service.parseInbound(msg({ text: 'summary' }));
    expect(r.kind === 'command' && r.command.payload).toEqual({ kind: 'get_summary', cycleId: '2026-10' });
  });
});

describe('identity and filtering', () => {
  it('ignores unknown senders and unrelated groups', async () => {
    const { service } = setup();
    expect((await service.parseInbound(msg({ senderId: 'stranger', text: 'summary' }))).kind).toBe('ignored');
    expect((await service.parseInbound(msg({ spaceId: 'other', text: 'summary' }))).kind).toBe('ignored');
  });
  it('derives commandId deterministically from the event', async () => {
    const { service } = setup();
    const a = await service.parseInbound(msg({ text: 'summary' }));
    const b = await service.parseInbound(msg({ text: 'summary' }));
    expect(a).toEqual(b);
  });
});

describe('tentative language', () => {
  it.each(['maybe I can cover', 'I might cover Jordan', 'should I approve?', 'could I cover it?'])('%s produces no command', async (text) => {
    const { service } = setup({ actionableProposals: [proposal('p1')] });
    expect((await service.parseInbound(msg({ text }))).kind).toBe('reply');
  });
  it('a hedged model approval is not an approval', async () => {
    const { service } = setup({ actionableProposals: [proposal('p1')] }, () => ({ intent: 'approve' }));
    expect((await service.parseInbound(msg({ text: 'i guess that looks fine' }))).kind).toBe('reply');
  });
  it('"what do I owe?" is a summary, not a payment', async () => {
    const { service } = setup({}, () => ({ intent: 'summary' }));
    const r = await service.parseInbound(msg({ text: 'what do I owe?' }));
    expect(r.kind === 'command' && r.command.payload.kind).toBe('get_summary');
  });
});

describe('approvals', () => {
  it('manual approve/decline carry exact id and version', async () => {
    const { service } = setup();
    const a = await service.parseInbound(msg({ text: 'approve p1 v2' }));
    expect(a.kind === 'command' && a.command.payload).toEqual({ kind: 'approve', proposalId: 'p1', proposalVersion: 2 });
    const d = await service.parseInbound(msg({ text: 'decline p1 v2' }));
    expect(d.kind === 'command' && d.command.payload).toEqual({ kind: 'decline', proposalId: 'p1', proposalVersion: 2 });
  });
  it('"yes" resolves to the single actionable proposal', async () => {
    const { service } = setup({ actionableProposals: [proposal('p1', 3)] });
    const r = await service.parseInbound(msg({ text: 'yes' }));
    expect(r.kind === 'command' && r.command.payload).toEqual({ kind: 'approve', proposalId: 'p1', proposalVersion: 3 });
  });
  it('two actionable proposals cause a clarification', async () => {
    const { service } = setup({ actionableProposals: [proposal('p1'), proposal('p2')] });
    expect((await service.parseInbound(msg({ text: 'yes' }))).kind).toBe('reply');
  });
  it('"yes" with nothing pending is ignored', async () => {
    const { service } = setup();
    expect((await service.parseInbound(msg({ text: 'yes' }))).kind).toBe('ignored');
  });
});

describe('reactions', () => {
  const react = (emoji = '👍') => msg({ eventId: 'r1', messageId: 'm9', reaction: { targetMessageId: 'bot-msg-1', emoji } });
  it('thumbs-up on the exact proposal message approves that id and version', async () => {
    const { service, lookups } = setup({ actionableProposals: [proposal('p1', 2)], targetProposal: { proposalId: 'p1', proposalVersion: 2 } });
    const r = await service.parseInbound(react());
    expect(r.kind === 'command' && r.command.payload).toEqual({ kind: 'approve', proposalId: 'p1', proposalVersion: 2 });
    expect(lookups[0]).toEqual(['mason', 'grp-1', 'bot-msg-1']);
  });
  it('reaction on a non-proposal message approves nothing', async () => {
    const { service } = setup({ actionableProposals: [proposal('p1')] });
    expect((await service.parseInbound(react())).kind).toBe('ignored');
  });
  it('reaction on a proposal this member cannot act on approves nothing', async () => {
    const { service } = setup({ actionableProposals: [proposal('other')], targetProposal: { proposalId: 'p1', proposalVersion: 1 } });
    expect((await service.parseInbound(react())).kind).toBe('ignored');
  });
  it('stale version on the reaction target approves nothing', async () => {
    const { service } = setup({ actionableProposals: [proposal('p1', 2)], targetProposal: { proposalId: 'p1', proposalVersion: 1 } });
    expect((await service.parseInbound(react())).kind).toBe('ignored');
  });
  it('unrelated emoji is ignored; thumbs-down declines', async () => {
    const { service } = setup({ actionableProposals: [proposal('p1')], targetProposal: { proposalId: 'p1', proposalVersion: 1 } });
    expect((await service.parseInbound(react('😂'))).kind).toBe('ignored');
    const d = await service.parseInbound(react('👎'));
    expect(d.kind === 'command' && d.command.payload.kind).toBe('decline');
  });
});

describe('private coverage dialogue', () => {
  const priv = (text: string) => msg({ visibility: 'private', spaceId: 'dm-p-jordan', senderId: 'jordan', text });
  const ctx = { openBills: [{ billId: 'b1', title: 'electricity' }], privateCoverageRequestId: 'cr1' };
  it('request for help becomes request_coverage for the single open bill', async () => {
    const { service } = setup({ openBills: ctx.openBills }, () => ({ intent: 'request_coverage' }));
    const r = await service.parseInbound(priv("I can't cover my share this month"));
    expect(r.kind === 'command' && r.command.payload).toEqual({ kind: 'request_coverage', billId: 'b1' });
  });
  it('private yes/no answers the share-consent question', async () => {
    const { service } = setup(ctx);
    const y = await service.parseInbound(priv('yes'));
    expect(y.kind === 'command' && y.command.payload).toEqual({ kind: 'share_coverage_request', requestId: 'cr1', consent: true });
    const n = await service.parseInbound(priv('no'));
    expect(n.kind === 'command' && n.command.payload).toEqual({ kind: 'share_coverage_request', requestId: 'cr1', consent: false });
  });
  it('a group "yes" can never answer a private consent question', async () => {
    const { service } = setup(ctx);
    expect((await service.parseInbound(msg({ senderId: 'jordan', text: 'yes' }))).kind).toBe('ignored');
  });
  it('group replies never mention a private request', async () => {
    const { service } = setup({ ...ctx, actionableProposals: [proposal('p1'), proposal('p2')] });
    const r = await service.parseInbound(msg({ senderId: 'jordan', text: 'yes' }));
    expect(r.kind === 'reply' && r.message.text).not.toMatch(/private|coverage request/i);
  });
  it('model input carries no balances or other-user private data', async () => {
    const { service, model } = setup(ctx);
    await service.parseInbound(priv('hmm what now'));
    expect(JSON.stringify(model.calls[0])).not.toMatch(/balance|cents/i);
  });
  it('volunteer offer needs an explicit request id and amount', async () => {
    const { service } = setup();
    const r = await service.parseInbound(msg({ senderId: 'alex', text: 'cover cr1 $48' }));
    expect(r.kind === 'command' && r.command.payload).toEqual({ kind: 'offer_coverage', requestId: 'cr1', amountCents: 4800 });
  });
  it('natural-language offer resolves the single open request when finance supplies it', async () => {
    const { service } = setup({ openCoverageRequests: [{ requestId: 'cr1', amountCents: 4800 }] }, () => ({ intent: 'offer_coverage' }));
    const r = await service.parseInbound(msg({ senderId: 'alex', text: "I'll cover Jordan" }));
    expect(r.kind === 'command' && r.command.payload).toEqual({ kind: 'offer_coverage', requestId: 'cr1', amountCents: 4800 });
  });
});
