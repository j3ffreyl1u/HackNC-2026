import { addCents, splitEqual, sumCents } from './money.js';
import { participantIds } from './state.js';
import type { CostCategory, MemberId, TripState } from './types.js';

// Pure funding arithmetic for the optional trip fund. The planner never moves or even sees money: callers read
// deposits and purchases from the bank and pass them in as plain lists, and these functions return plain
// results. Banks may store whole dollars only (Nessie truncates cents), so amounts here are whole dollars and
// every contribution is rounded UP, so the account is never short.

const toDollarsUp = (cents: number) => Math.ceil(cents / 100);

export interface ContributionRequest {
  memberId: MemberId;
  dollars: number;
}

export interface PooledCategory {
  category: CostCategory;
  plannedCents: number;
}

export type ContributionPlan =
  | {
      ok: true;
      candidateId: string;
      revision: number;
      /** What each person puts into the shared trip account: their share of shared costs plus contingency. */
      requests: ContributionRequest[];
      neededDollars: number;
      /** Costs that belong to one person (such as their own food). They stay with that person, not the pool. */
      personalOwnDollars: ContributionRequest[];
      pooledByCategory: PooledCategory[];
      contingencyCents: number;
    }
  | { ok: false; reason: string };

/**
 * What each person owes the shared fund for the approved plan. Only an approved plan at the current revision
 * can be funded, and a shared essential cost with no usable price blocks it: an unknown price is never zero.
 */
export function planContributions(state: TripState): ContributionPlan {
  if (state.status !== 'approved' || state.selectedCandidateId === undefined) {
    return { ok: false, reason: 'A plan has to be approved by everyone before contributions can be requested.' };
  }
  const candidate = state.candidates.find((c) => c.candidateId === state.selectedCandidateId && c.revision === state.revision);
  if (!candidate) return { ok: false, reason: 'The approved plan is out of date. Approve the latest plan first.' };

  const unknownShared = candidate.costs.filter((c) => c.allocation === 'equal_shared' && c.priceStatus === 'unknown' && c.essential !== false);
  if (unknownShared.length > 0) {
    return { ok: false, reason: 'A shared cost still has no confirmed price, so I can\'t say how much to collect yet.' };
  }

  const ids = participantIds(state);
  const sharedPriced = candidate.costs.filter((c) => c.allocation === 'equal_shared' && c.priceStatus !== 'unknown');
  const pooledCents = addCents(sumCents(sharedPriced.map((c) => c.highCents)), candidate.contingencyCents);
  const shares = splitEqual(pooledCents, ids);
  const requests = ids.map((memberId) => ({ memberId, dollars: toDollarsUp(shares[memberId]) }));

  const personalOwnDollars = ids.map((memberId) => ({
    memberId,
    dollars: toDollarsUp(sumCents(candidate.costs.filter((c) => c.allocation === 'personal' && c.memberId === memberId && c.priceStatus !== 'unknown').map((c) => c.highCents))),
  }));

  const byCategory = new Map<CostCategory, number>();
  for (const c of sharedPriced) byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + c.highCents);

  return {
    ok: true,
    candidateId: candidate.candidateId,
    revision: candidate.revision,
    requests,
    neededDollars: requests.reduce((total, r) => total + r.dollars, 0),
    personalOwnDollars,
    pooledByCategory: [...byCategory].map(([category, plannedCents]) => ({ category, plannedCents })),
    contingencyCents: candidate.contingencyCents,
  };
}

// ---- deposits ----------------------------------------------------------------------------------------------

/** The text a deposit carries so the fund can tell who paid for which plan revision. */
export function depositTag(memberId: MemberId, revision: number): string {
  return `member=${memberId};rev=${revision}`;
}

export function parseDepositTag(description: string): { memberId: MemberId; revision: number } | undefined {
  const match = /member=([^;]+);rev=(\d+)/.exec(description);
  if (!match) return undefined;
  const revision = Number(match[2]);
  return Number.isSafeInteger(revision) ? { memberId: match[1]!, revision } : undefined;
}

export interface Deposit {
  id?: string;
  amountDollars: number;
  description: string;
  /** Anything but `completed` is not counted. Absent means completed. */
  status?: string;
}

export interface MemberFunding {
  memberId: MemberId;
  requestedDollars: number;
  paidDollars: number;
  outstandingDollars: number;
}

export interface FundingReport {
  status: 'requesting' | 'partially_funded' | 'funded';
  neededDollars: number;
  collectedDollars: number;
  perMember: MemberFunding[];
  missingMemberIds: MemberId[];
  /** Deposits for an earlier revision of the plan. Their request was voided, so they don't count. */
  staleDollars: number;
  /** The same stale deposits per person, so each can be returned to whoever sent them. */
  staleByMember: { memberId: MemberId; dollars: number }[];
  /** Deposits that name nobody on the trip. They are held apart and never credited to a person. */
  unattributedDollars: number;
}

const usable = (amount: number) => Number.isFinite(amount) && amount >= 0;

/**
 * Collected against needed. A person is only covered by their own deposits: one large deposit does not pay
 * for the others. The trip counts as funded when every person has covered their own share.
 */
export function checkFunding(plan: Extract<ContributionPlan, { ok: true }>, deposits: readonly Deposit[]): FundingReport {
  const paid = new Map<MemberId, number>(plan.requests.map((r) => [r.memberId, 0]));
  const seen = new Set<string>();
  let stale = 0;
  const staleBy = new Map<MemberId, number>();
  let unattributed = 0;
  for (const deposit of deposits) {
    if (deposit.id !== undefined) {
      if (seen.has(deposit.id)) continue;
      seen.add(deposit.id);
    }
    if (deposit.status !== undefined && deposit.status !== 'completed') continue;
    if (!usable(deposit.amountDollars)) continue;
    const tag = parseDepositTag(deposit.description);
    if (!tag || !paid.has(tag.memberId)) {
      unattributed += deposit.amountDollars;
    } else if (tag.revision !== plan.revision) {
      stale += deposit.amountDollars;
      staleBy.set(tag.memberId, (staleBy.get(tag.memberId) ?? 0) + deposit.amountDollars);
    } else {
      paid.set(tag.memberId, (paid.get(tag.memberId) ?? 0) + deposit.amountDollars);
    }
  }
  const perMember = plan.requests.map((r) => {
    const paidDollars = paid.get(r.memberId) ?? 0;
    return { memberId: r.memberId, requestedDollars: r.dollars, paidDollars, outstandingDollars: Math.max(0, r.dollars - paidDollars) };
  });
  const collectedDollars = perMember.reduce((total, m) => total + m.paidDollars, 0);
  const missingMemberIds = perMember.filter((m) => m.outstandingDollars > 0).map((m) => m.memberId);
  const status = missingMemberIds.length === 0 ? 'funded' : collectedDollars > 0 ? 'partially_funded' : 'requesting';
  return { status, neededDollars: plan.neededDollars, collectedDollars, perMember, missingMemberIds, staleDollars: stale, staleByMember: plan.requests.filter((r) => staleBy.has(r.memberId)).map((r) => ({ memberId: r.memberId, dollars: staleBy.get(r.memberId)! })), unattributedDollars: unattributed };
}

// ---- spending ----------------------------------------------------------------------------------------------

/** A small, transparent mapping from a bank's merchant category. Anything else is left unclassified, never guessed. */
export function categoryForMerchant(merchantCategory: string | undefined): CostCategory | undefined {
  if (!merchantCategory) return undefined;
  const key = merchantCategory.trim().toLowerCase();
  if (['gas', 'fuel', 'gas station', 'parking', 'toll', 'tolls'].includes(key)) return 'fuel_parking_tolls';
  if (['food', 'restaurant', 'restaurants', 'grocery', 'groceries', 'cafe', 'coffee', 'dining'].includes(key)) return 'food';
  if (['lodging', 'hotel', 'motel', 'cabin', 'rental', 'airbnb', 'accommodation'].includes(key)) return 'accommodation';
  if (['parks', 'park', 'entertainment', 'activities', 'recreation', 'tour', 'museum'].includes(key)) return 'activities';
  if (['fees', 'taxes', 'taxes_fees'].includes(key)) return 'taxes_fees';
  return undefined;
}

const COST_CATEGORIES: readonly CostCategory[] = ['accommodation', 'fuel_parking_tolls', 'food', 'activities', 'taxes_fees', 'other'];

export interface Purchase {
  id?: string;
  amountDollars: number;
  /** A plan category, or a bank's merchant category. */
  category?: string;
  status?: string;
}

export interface CategorySpend {
  category: CostCategory;
  plannedDollars: number;
  spentDollars: number;
  /** `near` is 80% of the budget or more. `over` includes spending in a category the pool never budgeted. */
  state: 'within' | 'near' | 'over';
}

export interface SpendReport {
  byCategory: CategorySpend[];
  overCategories: CostCategory[];
  unclassifiedDollars: number;
  totalSpentDollars: number;
  contingencyDollars: number;
}

const NEAR_SHARE = 0.8;

/** Spending from the shared fund against what the plan budgeted for it, by category. */
export function spendVsPlan(plan: Extract<ContributionPlan, { ok: true }>, purchases: readonly Purchase[]): SpendReport {
  const spent = new Map<CostCategory, number>();
  const seen = new Set<string>();
  let unclassified = 0;
  let total = 0;
  for (const purchase of purchases) {
    if (purchase.id !== undefined) {
      if (seen.has(purchase.id)) continue;
      seen.add(purchase.id);
    }
    if (purchase.status !== undefined && purchase.status !== 'completed') continue;
    if (!usable(purchase.amountDollars)) continue;
    total += purchase.amountDollars;
    const raw = purchase.category?.trim().toLowerCase();
    const category = COST_CATEGORIES.find((c) => c === raw) ?? categoryForMerchant(purchase.category);
    if (category === undefined) unclassified += purchase.amountDollars;
    else spent.set(category, (spent.get(category) ?? 0) + purchase.amountDollars);
  }
  const planned = new Map(plan.pooledByCategory.map((p) => [p.category, toDollarsUp(p.plannedCents)]));
  const categories = COST_CATEGORIES.filter((c) => planned.has(c) || spent.has(c));
  const byCategory = categories.map((category) => {
    const plannedDollars = planned.get(category) ?? 0;
    const spentDollars = spent.get(category) ?? 0;
    const state: CategorySpend['state'] =
      spentDollars > plannedDollars ? 'over' : plannedDollars > 0 && spentDollars >= plannedDollars * NEAR_SHARE ? 'near' : 'within';
    return { category, plannedDollars, spentDollars, state };
  });
  return {
    byCategory,
    overCategories: byCategory.filter((c) => c.state === 'over').map((c) => c.category),
    unclassifiedDollars: unclassified,
    totalSpentDollars: total,
    contingencyDollars: Math.floor(plan.contingencyCents / 100),
  };
}

// ---- what the bot says -------------------------------------------------------------------------------------

const money = (dollars: number) => `$${dollars.toLocaleString('en-US')}`;
const list = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The answer to "how's the fund?": what is in, who the fund is still waiting on, and, once spending is known,
 * what has gone out and what is left. Names appear only for amounts owed to the shared fund, never for limits.
 */
export function describeFund(
  state: TripState,
  plan: Extract<ContributionPlan, { ok: true }>,
  funding: FundingReport,
  spend?: SpendReport,
  options: { simulated?: boolean } = {},
): string {
  const name = (id: MemberId) => state.roster.find((m) => m.memberId === id)?.displayName ?? id;
  const lines: string[] = [];
  if (funding.status === 'funded') {
    lines.push(`The trip fund is fully funded: ${money(funding.collectedDollars)} in, ${money(plan.neededDollars)} needed.`);
  } else {
    const waiting = funding.perMember.filter((m) => m.outstandingDollars > 0).map((m) => `${name(m.memberId)} (${money(m.outstandingDollars)})`);
    lines.push(`The trip fund has ${money(funding.collectedDollars)} of ${money(plan.neededDollars)}. Still waiting on ${list(waiting)}.`);
  }
  if (spend !== undefined) {
    lines.push(`${money(spend.totalSpentDollars)} spent so far, ${money(Math.max(0, funding.collectedDollars - spend.totalSpentDollars))} left.`);
  }
  if (options.simulated) lines.push('This is simulated money in a demo account.');
  return lines.join(' ');
}

/** A private nudge for one person about their own share. Nothing about anyone else; undefined if they are covered. */
export function reminderFor(memberId: MemberId, funding: FundingReport): string | undefined {
  const mine = funding.perMember.find((m) => m.memberId === memberId);
  if (!mine || mine.outstandingDollars === 0) return undefined;
  return `Your share of the trip fund is ${money(mine.requestedDollars)} and I see ${money(mine.paidDollars)} so far, so ${money(mine.outstandingDollars)} to go.`;
}

export interface DriftNotice {
  /** Stable, so the caller can remember which notices it has already sent. */
  key: string;
  text: string;
}

const CATEGORY_WORDS: Record<CostCategory, string> = {
  accommodation: 'lodging',
  fuel_parking_tolls: 'gas, parking and tolls',
  food: 'food',
  activities: 'activities',
  taxes_fees: 'taxes and fees',
  other: 'other costs',
};

/**
 * Calm notices for spending that is nearly or fully used up, or that the plan never budgeted. Each notice is
 * given once: pass the keys already sent and only new or worse ones come back. A notice only offers to look for
 * cheaper options; changing the plan always takes everyone's agreement.
 */
export function driftNotices(report: SpendReport, announced: ReadonlySet<string>): DriftNotice[] {
  const notices: DriftNotice[] = [];
  for (const entry of report.byCategory) {
    if (entry.state === 'within') continue;
    const key = `${entry.category}:${entry.state}`;
    if (announced.has(key)) continue;
    const word = CATEGORY_WORDS[entry.category];
    if (entry.plannedDollars === 0) {
      notices.push({ key, text: `${money(entry.spentDollars)} went to ${word}, which the shared plan didn't budget. If that's a personal cost, ignore this; otherwise it comes out of the contingency.` });
    } else if (entry.state === 'near') {
      notices.push({ key, text: `Heads up: ${word} is at ${money(entry.spentDollars)} of the ${money(entry.plannedDollars)} planned. Nothing to do yet.` });
    } else {
      notices.push({ key, text: `${word[0]!.toUpperCase()}${word.slice(1)} is over its budget: ${money(entry.spentDollars)} spent against ${money(entry.plannedDollars)} planned. I can look for cheaper options for the rest of the trip. Changing the plan would be a new version that everyone would need to agree to.` });
    }
  }
  if (report.unclassifiedDollars > 0 && !announced.has('unclassified')) {
    notices.push({ key: 'unclassified', text: `${money(report.unclassifiedDollars)} of spending doesn't match any category in the plan, so I'm not counting it against a budget.` });
  }
  return notices;
}

// ---- wrap-up ------------------------------------------------------------------------------------------------

export interface Settlement {
  collectedDollars: number;
  spentDollars: number;
  /** Collected minus spent. Negative means the fund was overspent. */
  leftoverDollars: number;
  /** What is left, back to the people who put it in, in proportion to what each put in. Adds up exactly. */
  refunds: { memberId: MemberId; dollars: number }[];
  /** Only when overspent: how much, and an equal whole-dollar split of it (rounded up so it is covered). */
  shortfall?: { dollars: number; perMember: { memberId: MemberId; dollars: number }[] };
  /** Money sent for an older plan revision, to go back to whoever sent it in full. */
  staleReturns: { memberId: MemberId; dollars: number }[];
  /** Money that named nobody on the trip. Held apart until someone claims it. */
  unattributedDollars: number;
}

/**
 * Work out the end of the trip from the same two reports the fund view uses. It only calculates: the bot tells
 * people who gets what back and never moves money. Refunds use the largest-remainder method on whole dollars so
 * they always add up to the leftover exactly, and a person who put in more never gets less back.
 */
export function settleTrip(plan: Extract<ContributionPlan, { ok: true }>, funding: FundingReport, spend: SpendReport): Settlement {
  const collected = funding.collectedDollars;
  const spent = spend.totalSpentDollars;
  const leftover = collected - spent;
  const base = {
    collectedDollars: collected,
    spentDollars: spent,
    leftoverDollars: leftover,
    staleReturns: funding.staleByMember,
    unattributedDollars: funding.unattributedDollars,
  };
  if (leftover < 0) {
    const each = Math.ceil(-leftover / plan.requests.length);
    return { ...base, refunds: [], shortfall: { dollars: -leftover, perMember: plan.requests.map((r) => ({ memberId: r.memberId, dollars: each })) } };
  }
  if (leftover === 0 || collected === 0) return { ...base, refunds: [] };

  const shares = funding.perMember.map((m, order) => {
    const numerator = leftover * m.paidDollars;
    return { memberId: m.memberId, order, dollars: Math.floor(numerator / collected), remainder: numerator % collected };
  });
  let extra = leftover - shares.reduce((total, share) => total + share.dollars, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder || a.order - b.order)) {
    if (extra === 0) break;
    share.dollars += 1;
    extra -= 1;
  }
  return { ...base, refunds: shares.filter((s) => s.dollars > 0).map(({ memberId, dollars }) => ({ memberId, dollars })) };
}

/** The wrap-up message: what came in, what went out, who gets what back, and that the bot moves nothing. */
export function describeSettlement(state: TripState, settlement: Settlement, options: { simulated?: boolean } = {}): string {
  const name = (id: MemberId) => state.roster.find((m) => m.memberId === id)?.displayName ?? id;
  const lines: string[] = [];
  if (settlement.shortfall) {
    const each = settlement.shortfall.perMember[0]?.dollars ?? 0;
    lines.push(`Trip fund wrap-up: ${money(settlement.collectedDollars)} in, ${money(settlement.spentDollars)} spent, so the fund is ${money(settlement.shortfall.dollars)} short. Splitting that evenly would be ${money(each)} each.`);
  } else {
    lines.push(`Trip fund wrap-up: ${money(settlement.collectedDollars)} in, ${money(settlement.spentDollars)} spent, ${money(settlement.leftoverDollars)} left.`);
    if (settlement.refunds.length > 0) lines.push(`To send back: ${settlement.refunds.map((r) => `${name(r.memberId)} ${money(r.dollars)}`).join(', ')}.`);
  }
  if (settlement.staleReturns.length > 0) {
    lines.push(`Also return what was sent for an earlier version of the plan: ${settlement.staleReturns.map((r) => `${name(r.memberId)} ${money(r.dollars)}`).join(', ')}.`);
  }
  if (settlement.unattributedDollars > 0) lines.push(`${money(settlement.unattributedDollars)} didn't say who it was from, so someone needs to claim it.`);
  lines.push("I don't move any money, so you'd send these yourselves.");
  if (options.simulated) lines.push('This is simulated money in a demo account.');
  return lines.join(' ');
}
