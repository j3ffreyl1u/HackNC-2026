import { formatUsd, planCarryover, splitEqual, type CarryoverDebt } from './accounting.js';
import type {
  AllocationLine,
  BillRecord,
  CreditApplication,
  Ledger,
  MemberRecord,
  ProposalRecord,
} from './ledger.js';
import type { IdGenerator } from './runtime.js';
import type { Scope, Notifier } from './support.js';
import type { LedgerStore } from './store.js';

export interface BillTerms {
  title: string;
  amountCents: number;
  dueDate: string;
  recipientId: string;
  cycleId: string;
}

/**
 * Creates bills with their contribution proposals, applying carried-over credit.
 *
 * Every member's agreed share stays the plain equal split. A debtor's request is their own share plus
 * the credit they repay; the creditor's request shrinks by the same amount. Requests are previews:
 * nothing is settled here. A debt gets one pending settlement, applied to bills in order, so the same
 * credit can never be spent on a second bill.
 */
export class Billing {
  constructor(
    private readonly store: LedgerStore,
    private readonly ledger: Ledger,
    private readonly notify: Notifier,
    private readonly newId: IdGenerator,
  ) {}

  createBills(scope: Scope, members: MemberRecord[], termsList: BillTerms[]): BillRecord[] {
    const memberIds = members.map((m) => m.userId);
    const debts = this.ledger
      .unsettledDebts(scope.householdId)
      .filter((d) => memberIds.includes(d.debtorId) && memberIds.includes(d.creditorId));
    const remaining = new Map(debts.map((d) => [d.debtId, d.remainingCents]));
    const applied = new Map<string, CreditApplication[]>();
    const created: BillRecord[] = [];

    for (const terms of termsList) {
      const bill: BillRecord = {
        billId: this.newId('bill'),
        householdId: scope.householdId,
        cycleId: terms.cycleId,
        title: terms.title,
        amountCents: terms.amountCents,
        dueDate: terms.dueDate,
        recipientId: terms.recipientId,
        status: 'collecting',
      };
      const shares = splitEqual(terms.amountCents, memberIds);
      const live: CarryoverDebt[] = debts
        .filter((d) => (remaining.get(d.debtId) ?? 0) > 0)
        .map((d) => ({ debtId: d.debtId, debtorId: d.debtorId, creditorId: d.creditorId, remainingCents: remaining.get(d.debtId)! }));
      const plan = planCarryover(shares, live);

      const credits = plan.applications.filter((a) => a.appliedCents > 0);
      for (const a of credits) {
        remaining.set(a.debtId, (remaining.get(a.debtId) ?? 0) - a.appliedCents);
        applied.set(a.debtId, [...(applied.get(a.debtId) ?? []), { billId: bill.billId, amountCents: a.appliedCents }]);
      }

      this.ledger.insertBill(bill, scope.now);
      this.ledger.setObligations(bill.billId, shares);
      this.propose(scope, members, bill, plan.requests, credits);
      created.push(bill);
    }

    for (const [debtId, applications] of applied) {
      const total = applications.reduce((sum, a) => sum + a.amountCents, 0);
      const cycleId = termsList[0]?.cycleId ?? '';
      this.store.createSettlement(this.newId('settle'), debtId, cycleId, total, scope.now, applications);
    }
    return created;
  }

  private propose(
    scope: Scope,
    members: MemberRecord[],
    bill: BillRecord,
    requests: Record<string, number>,
    credits: Array<{ debtorId: string; creditorId: string; appliedCents: number }>,
  ): void {
    const recipient = this.ledger.recipient(scope.householdId, bill.recipientId);
    const recipientName = recipient?.displayName ?? bill.recipientId;
    const names = new Map(members.map((m) => [m.userId, m.displayName]));

    for (const member of members) {
      const request = requests[member.userId] ?? 0;
      if (request <= 0) continue;
      const repaid = credits.filter((c) => c.debtorId === member.userId);
      const received = credits.filter((c) => c.creditorId === member.userId);
      const repaidTotal = repaid.reduce((sum, c) => sum + c.appliedCents, 0);

      const allocation: AllocationLine[] = [];
      if (request - repaidTotal > 0) {
        allocation.push({ payerId: member.userId, beneficiaryId: member.userId, amountCents: request - repaidTotal, kind: 'own' });
      }
      for (const c of repaid) {
        allocation.push({ payerId: c.debtorId, beneficiaryId: c.creditorId, amountCents: c.appliedCents, kind: 'credit_settlement' });
      }

      const proposal: ProposalRecord = {
        ...this.notify.contributionProposal(scope, bill, member, request, this.newId('prop'), 1),
        allocation,
      };
      this.ledger.insertProposal(proposal, scope.now);

      if (repaid.length === 0 && received.length === 0) {
        this.notify.announceRequest(scope, bill, proposal, member, recipientName, false);
        continue;
      }
      const text = this.carryoverText(bill, proposal, member, recipientName, names, repaid, received);
      this.notify.toGroup(scope, `deliv:${proposal.proposalId}:v1:request`, text, {
        proposalId: proposal.proposalId,
        proposalVersion: 1,
      });
    }
  }

  private carryoverText(
    bill: BillRecord,
    proposal: ProposalRecord,
    member: MemberRecord,
    recipientName: string,
    names: Map<string, string>,
    repaid: Array<{ creditorId: string; appliedCents: number }>,
    received: Array<{ debtorId: string; appliedCents: number }>,
  ): string {
    const share = formatUsd(Math.floor(bill.amountCents / names.size));
    let why: string;
    if (repaid.length > 0) {
      const parts = repaid.map((c) => `${formatUsd(c.appliedCents)} repaying ${names.get(c.creditorId) ?? c.creditorId} for an earlier bill`);
      why = `${member.displayName}'s request is ${formatUsd(proposal.amountCents)}: their share plus ${parts.join(' and ')}.`;
    } else {
      const parts = received.map((c) => `${names.get(c.debtorId) ?? c.debtorId}'s ${formatUsd(c.appliedCents)} repayment`);
      why =
        `${member.displayName}'s request is ${formatUsd(proposal.amountCents)} because ${parts.join(' and ')} covers the rest of their share. ` +
        `The earlier debt stays open until both payments are confirmed.`;
    }
    return (
      `${bill.title}: ${formatUsd(bill.amountCents)} due ${bill.dueDate}, payable to ${recipientName} (shares of about ${share}). ${why} ` +
      `${member.displayName}: react 👍 to this message or reply "approve ${proposal.proposalId} v${proposal.version}".`
    );
  }
}
