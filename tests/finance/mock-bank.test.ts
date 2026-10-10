import { beforeEach, describe, expect, it } from 'vitest';
import { transferMatches, type SubmitTransferInput } from '../../src/finance/bank';
import { MockBank } from '../../src/finance/mock-bank';

const input = (overrides: Partial<SubmitTransferInput> = {}): SubmitTransferInput => ({
  operationId: 'op-1',
  fromAccountId: 'acct-mason',
  toAccountId: 'acct-house',
  amountCents: 4_800,
  description: 'October electricity share',
  ...overrides,
});

let bank: MockBank;
beforeEach(() => {
  bank = new MockBank({ balances: { 'acct-mason': 100_000, 'acct-house': 0 } });
});

describe('MockBank transfers', () => {
  it('moves funds on a confirmed transfer and reports matching details', async () => {
    const result = await bank.submitTransfer(input());
    expect(result.status).toBe('confirmed');
    expect(result.providerTransactionId).toBeTruthy();
    expect(await bank.getBalance('acct-mason')).toBe(95_200);
    expect(await bank.getBalance('acct-house')).toBe(4_800);
    expect(transferMatches(result, { fromAccountId: 'acct-mason', toAccountId: 'acct-house', amountCents: 4_800 })).toBe(true);
  });

  it('fails without moving funds when the source is short', async () => {
    const result = await bank.submitTransfer(input({ amountCents: 200_000 }));
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('insufficient funds');
    expect(await bank.getBalance('acct-mason')).toBe(100_000);
  });

  it('rejects non-integer and non-positive amounts', async () => {
    expect((await bank.submitTransfer(input({ amountCents: 10.5 }))).status).toBe('failed');
    expect((await bank.submitTransfer(input({ operationId: 'op-2', amountCents: 0 }))).status).toBe('failed');
    expect(bank.transferCount).toBe(0);
  });

  it('transferMatches rejects a wrong amount, source or destination', () => {
    const result = { status: 'confirmed' as const, amountCents: 4_800, fromAccountId: 'a', toAccountId: 'b' };
    expect(transferMatches(result, { fromAccountId: 'a', toAccountId: 'b', amountCents: 4_801 })).toBe(false);
    expect(transferMatches(result, { fromAccountId: 'x', toAccountId: 'b', amountCents: 4_800 })).toBe(false);
    expect(transferMatches(result, { fromAccountId: 'a', toAccountId: 'x', amountCents: 4_800 })).toBe(false);
    expect(transferMatches({ status: 'confirmed' }, { fromAccountId: 'a', toAccountId: 'b', amountCents: 1 })).toBe(false);
  });
});

describe('MockBank injected failures', () => {
  it("'fail' rejects the transfer and moves nothing", async () => {
    bank.inject('fail');
    const result = await bank.submitTransfer(input());
    expect(result.status).toBe('failed');
    expect(await bank.getBalance('acct-house')).toBe(0);
  });

  it("'pending' holds funds until settled, then confirms", async () => {
    bank.inject('pending');
    const result = await bank.submitTransfer(input());
    expect(result.status).toBe('pending');
    expect(await bank.getBalance('acct-house')).toBe(0);

    bank.settle(result.providerTransactionId!);
    expect((await bank.getTransfer(result.providerTransactionId!)).status).toBe('confirmed');
    expect(await bank.getBalance('acct-house')).toBe(4_800);
  });

  it('a pending transfer can settle as failed without moving funds', async () => {
    bank.inject('pending');
    const result = await bank.submitTransfer(input());
    bank.settle(result.providerTransactionId!, 'failed');
    expect((await bank.getTransfer(result.providerTransactionId!)).status).toBe('failed');
    expect(await bank.getBalance('acct-mason')).toBe(100_000);
  });

  it("'throw-before' throws and the provider holds nothing", async () => {
    bank.inject('throw-before');
    await expect(bank.submitTransfer(input())).rejects.toThrow();
    expect(bank.transferCount).toBe(0);
    expect(await bank.findTransfer('op-1', 'acct-mason')).toBeNull();
  });

  it("'throw-after' throws although the transfer executed, and lookup finds it", async () => {
    bank.inject('throw-after');
    await expect(bank.submitTransfer(input())).rejects.toThrow();
    expect(await bank.getBalance('acct-house')).toBe(4_800);

    const found = await bank.findTransfer('op-1', 'acct-mason');
    expect(found?.status).toBe('confirmed');
  });

  it("'unknown-response' returns unknown while the provider holds a pending transfer", async () => {
    bank.inject('unknown-response');
    const result = await bank.submitTransfer(input());
    expect(result.status).toBe('unknown');
    expect(bank.transferCount).toBe(1);
    expect((await bank.findTransfer('op-1', 'acct-mason'))?.status).toBe('pending');
  });

  it('consumes injected behaviors in order, then behaves normally', async () => {
    bank.inject('fail', 'pending');
    expect((await bank.submitTransfer(input({ operationId: 'a' }))).status).toBe('failed');
    expect((await bank.submitTransfer(input({ operationId: 'b' }))).status).toBe('pending');
    expect((await bank.submitTransfer(input({ operationId: 'c' }))).status).toBe('confirmed');
  });
});

describe('MockBank lookup and idempotency', () => {
  it('findTransfer returns null for an operation the provider never saw', async () => {
    expect(await bank.findTransfer('nope', 'acct-mason')).toBeNull();
  });

  it('findTransfer only matches the same source account', async () => {
    await bank.submitTransfer(input());
    expect(await bank.findTransfer('op-1', 'acct-alex')).toBeNull();
  });

  it('findTransfer returns unknown, never a guess, when lookup is unsupported', async () => {
    await bank.submitTransfer(input());
    bank.setSupportsFindTransfer(false);
    expect((await bank.findTransfer('op-1', 'acct-mason'))?.status).toBe('unknown');
    expect((await bank.findTransfer('never-sent', 'acct-mason'))?.status).toBe('unknown');
  });

  it('by default a resubmitted operationId moves money twice (no assumed provider idempotency)', async () => {
    await bank.submitTransfer(input());
    await bank.submitTransfer(input());
    expect(await bank.getBalance('acct-house')).toBe(9_600);
    expect(bank.submitCalls).toHaveLength(2);
  });

  it('can model an idempotent provider that returns the original transfer', async () => {
    const idempotent = new MockBank({ balances: { 'acct-mason': 100_000 }, idempotentByOperationId: true });
    const first = await idempotent.submitTransfer(input());
    const second = await idempotent.submitTransfer(input());
    expect(second.providerTransactionId).toBe(first.providerTransactionId);
    expect(await idempotent.getBalance('acct-house')).toBe(4_800);
  });

  it('getTransfer on an unknown ID is unknown, not failed', async () => {
    expect((await bank.getTransfer('missing')).status).toBe('unknown');
  });
});
