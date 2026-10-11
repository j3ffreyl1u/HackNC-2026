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
  return { status, neededDollars: plan.neededDollars, collectedDollars, perMember, missingMemberIds, staleDollars: stale, unattributedDollars: unattributed };
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
