import { formatUsd } from './accounting.js';
import type { Command, DomainErrorCode, OutboundMessage } from '../contracts/index.js';
import type { BillRecord, Ledger, MemberRecord, ProposalRecord } from './ledger.js';
import type { LedgerStore } from './store.js';

/** An ordinary invalid user action. Thrown inside a transaction so every write rolls back. */
export class Rejection extends Error {
  constructor(
    readonly code: DomainErrorCode,
    readonly userMessage: string,
  ) {
    super(userMessage);
  }
}

export const reject = (code: DomainErrorCode, userMessage: string): never => {
  throw new Rejection(code, userMessage);
};

export const STALE_MESSAGE = 'That request has changed. Please approve the latest version.';

/** Everything a command handler needs about who is acting and where. */
export interface Context {
  command: Command;
  householdId: string;
  groupSpaceId: string;
  householdAccountId: string;
  actor: MemberRecord;
  members: MemberRecord[];
  now: string;
}

/** Builds and queues the household's messages and contribution proposals. */
export class Notifier {
  constructor(
    private readonly store: LedgerStore,
    private readonly ledger: Ledger,
  ) {}

  toGroup(ctx: Context, deliveryId: string, text: string, proposalRef?: OutboundMessage['proposalRef']): void {
    this.store.enqueueOutbox(
      {
        deliveryId,
        householdId: ctx.householdId,
        audience: { kind: 'group', spaceId: ctx.groupSpaceId },
        text,
        ...(proposalRef ? { proposalRef } : {}),
      },
      ctx.now,
    );
  }

  toPrivate(ctx: Context, userId: string, deliveryId: string, text: string): void {
    this.store.enqueueOutbox(
      { deliveryId, householdId: ctx.householdId, audience: { kind: 'private', userId }, text },
      ctx.now,
    );
  }

  contributionProposal(
    ctx: Context,
    bill: BillRecord,
    member: MemberRecord,
    cents: number,
    proposalId: string,
    version: number,
  ): ProposalRecord {
    return {
      proposalId,
      householdId: ctx.householdId,
      billId: bill.billId,
      purpose: 'contribution',
      version,
      status: 'proposed',
      amountCents: cents,
      sourceAccountId: member.bankAccountId,
      destinationAccountId: ctx.householdAccountId,
      requiredActorIds: [member.userId],
      allocation: [{ payerId: member.userId, beneficiaryId: member.userId, amountCents: cents, kind: 'own' }],
      description: `${member.displayName} contributes ${formatUsd(cents)} to the household account for ${bill.title}`,
    };
  }

  announceRequest(
    ctx: Context,
    bill: BillRecord,
    proposal: ProposalRecord,
    member: MemberRecord,
    recipientName: string,
    revised: boolean,
  ): void {
    const lead = revised ? `Updated request for ${bill.title}` : bill.title;
    const text =
      `${lead}: ${formatUsd(bill.amountCents)} due ${bill.dueDate}, payable to ${recipientName}. ` +
      `${member.displayName}'s share is ${formatUsd(proposal.amountCents)} into the shared household account (simulated). ` +
      `${member.displayName}: react 👍 to this message or reply "approve ${proposal.proposalId} v${proposal.version}".`;
    this.toGroup(ctx, `deliv:${proposal.proposalId}:v${proposal.version}:request`, text, {
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
    });
  }
}
