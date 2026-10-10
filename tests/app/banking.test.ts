import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HouseholdConfig } from '../../src/contracts/index.js';
import { MOCK_MEMBER_STARTING_BALANCE_CENTS, prepareMockBankBootstrap } from '../../src/app/banking.js';

async function fixture(): Promise<HouseholdConfig> {
  return JSON.parse(await readFile(resolve('tests/fixtures/household.json'), 'utf8')) as HouseholdConfig;
}

describe('mock bank app bootstrap', () => {
  it('uses persisted seed IDs and resets only in-memory balances to documented starting amounts', async () => {
    const config = await fixture();
    const saved = new Map([
      ['seed_account:member-mason', 'saved-mason'],
      ['seed_account:member-alex', 'saved-alex'],
      ['seed_account:member-jordan', 'saved-jordan'],
      ['seed_account:household', 'saved-household'],
      ['seed_account:recipient-electric', 'saved-recipient'],
    ]);
    const getMeta = vi.fn((_householdId: string, key: string) => saved.get(key) ?? null);

    const result = prepareMockBankBootstrap(config, getMeta);

    expect(result.household.householdAccountId).toBe('saved-household');
    expect(result.household.members.map((member) => member.bankAccountId)).toEqual(['saved-mason', 'saved-alex', 'saved-jordan']);
    expect(result.household.recipients[0].bankAccountId).toBe('saved-recipient');
    expect(result.balances).toEqual({
      'saved-household': 0,
      'saved-mason': MOCK_MEMBER_STARTING_BALANCE_CENTS,
      'saved-alex': MOCK_MEMBER_STARTING_BALANCE_CENTS,
      'saved-jordan': MOCK_MEMBER_STARTING_BALANCE_CENTS,
      'saved-recipient': 0,
    });
    expect(getMeta).toHaveBeenCalledTimes(5);
  });

  it('uses deterministic mock IDs before the seed command has saved mappings', async () => {
    const config = await fixture();
    const result = prepareMockBankBootstrap(config, () => null);

    expect(result.household.householdAccountId).toBe('mock-demo-house-household');
    expect(result.household.members[0].bankAccountId).toBe('mock-demo-house-member-mason');
    expect(result.household.recipients[0].bankAccountId).toBe('mock-demo-house-recipient-electric');
  });
});
