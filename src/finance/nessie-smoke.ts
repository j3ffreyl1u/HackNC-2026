import { operationTag, type NessieBank } from './nessie.js';

export interface SmokeCheck {
  name: string;
  /** `null` means the check could not be evaluated. */
  passed: boolean | null;
  detail: string;
}

export interface NessieSmokeReport {
  checks: SmokeCheck[];
  /** True only if every check passed. A failed check is a finding, not a crash. */
  allPassed: boolean;
}

/**
 * Operator-run live check for the Nessie sandbox: moves a small amount between two sandbox accounts and
 * records what the service actually does, so assumptions are replaced by observation. It moves simulated
 * money only, writes no secrets, and reports findings rather than throwing on them.
 */
export async function runNessieSmoke(
  bank: NessieBank,
  input: { fromAccountId: string; toAccountId: string; amountCents?: number; operationId?: string },
): Promise<NessieSmokeReport> {
  const amountCents = input.amountCents ?? 100;
  const operationId = input.operationId ?? `smoke-${Date.now()}`;
  const checks: SmokeCheck[] = [];
  const add = (name: string, passed: boolean | null, detail: string) => checks.push({ name, passed, detail });
  const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

  let fromBefore: number | null = null;
  let toBefore: number | null = null;
  try {
    fromBefore = await bank.getBalance(input.fromAccountId);
    toBefore = await bank.getBalance(input.toAccountId);
    add('read both account balances', true, `source ${fromBefore}c, destination ${toBefore}c`);
  } catch (error) {
    add('read both account balances', false, failure(error));
  }

  let providerId: string | undefined;
  try {
    const result = await bank.submitTransfer({
      operationId,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountCents,
      description: 'Splitbot smoke check (simulated)',
    });
    providerId = result.providerTransactionId;
    add('transfer accepted', result.status === 'confirmed' || result.status === 'pending', `status ${result.status}${result.reason ? `: ${result.reason}` : ''}`);
    add('transfer echoes the payer', result.fromAccountId === undefined ? false : result.fromAccountId === input.fromAccountId, `payer ${result.fromAccountId ?? 'missing'}`);
    add('transfer echoes the payee', result.toAccountId === undefined ? false : result.toAccountId === input.toAccountId, `payee ${result.toAccountId ?? 'missing'}`);
    add('amount is exact in cents', result.amountCents === amountCents, `sent ${amountCents}c, read back ${result.amountCents ?? 'missing'}c`);
  } catch (error) {
    add('transfer accepted', false, failure(error));
  }

  if (providerId) {
    try {
      const again = await bank.getTransfer(providerId);
      add('transfer readable by ID', again.status !== 'unknown', `status ${again.status}`);
    } catch (error) {
      add('transfer readable by ID', false, failure(error));
    }
  }

  try {
    const found = await bank.findTransfer(operationId, input.fromAccountId);
    add(
      `lookup by operation tag ${operationTag(operationId)}`,
      found !== null && found.status !== 'unknown',
      found === null ? 'not listed' : `status ${found.status}${found.reason ? `: ${found.reason}` : ''}`,
    );
  } catch (error) {
    add('lookup by operation tag', false, failure(error));
  }

  if (fromBefore !== null && toBefore !== null) {
    try {
      const fromAfter = await bank.getBalance(input.fromAccountId);
      const toAfter = await bank.getBalance(input.toAccountId);
      const moved = fromBefore - fromAfter === amountCents && toAfter - toBefore === amountCents;
      add(
        'balances move',
        moved,
        moved
          ? 'both balances changed by the transfer amount'
          : `source ${fromBefore}c -> ${fromAfter}c, destination ${toBefore}c -> ${toAfter}c; balances cannot be used as proof of payment`,
      );
    } catch (error) {
      add('balances move', false, failure(error));
    }
  }

  return { checks, allPassed: checks.every((c) => c.passed === true) };
}
