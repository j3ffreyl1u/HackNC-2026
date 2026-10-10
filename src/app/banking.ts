import type { HouseholdConfig } from '../contracts/index.js';

export const MOCK_MEMBER_STARTING_BALANCE_CENTS = 100_000;

export interface MockBankBootstrap {
  household: HouseholdConfig;
  balances: Record<string, number>;
}

/** Rebuilds a fresh process-local MockBank from saved IDs and documented demo starting balances. */
export function prepareMockBankBootstrap(
  config: HouseholdConfig,
  getMeta: (householdId: string, key: string) => string | null,
): MockBankBootstrap {
  const accountId = (label: string): string =>
    getMeta(config.householdId, `seed_account:${label}`)
    ?? `mock-${`${config.householdId}-${label}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

  const members = config.members.map((member) => ({
    ...member,
    bankAccountId: accountId(`member-${member.userId}`),
  }));
  const recipients = config.recipients.map((recipient) => ({
    ...recipient,
    bankAccountId: accountId(`recipient-${recipient.recipientId}`),
  }));
  const householdAccountId = accountId('household');
  const household: HouseholdConfig = { ...config, members, recipients, householdAccountId };
  const balances: Record<string, number> = {
    [householdAccountId]: 0,
    ...Object.fromEntries(members.map((member) => [member.bankAccountId, MOCK_MEMBER_STARTING_BALANCE_CENTS])),
    ...Object.fromEntries(recipients.map((recipient) => [recipient.bankAccountId, 0])),
  };
  return { household, balances };
}
