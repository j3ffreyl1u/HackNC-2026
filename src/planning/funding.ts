import { addCents, splitEqual, sumCents } from './money.js';
import { participantIds } from './state.js';
import type { CostCategory, MemberId, TripState } from './types.js';

// Pure arithmetic for tracking who covered what on the trip. Nobody pays into a shared account: each friend pays
// for things with their own money, the bank (a sandbox in the demo) reports each person's purchases, and these
// functions work out each person's fair share and who would owe whom. The planner never moves or even sees money:
// callers read purchases from the banks and pass them in as plain lists, and these functions return plain results.
// Banks may store whole dollars only (Nessie truncates cents), so amounts here are whole dollars.

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
      /** What the plan expects each person's share of the shared costs (plus contingency) to be. An estimate to compare against, not a request. */
      requests: ContributionRequest[];
      neededDollars: number;
      /** Costs that belong to one person (such as their own food). They stay with that person and are never split. */
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
    return { ok: false, reason: 'A plan has to be approved by everyone before I can track who covered what.' };
  }
  const candidate = state.candidates.find((c) => c.candidateId === state.selectedCandidateId && c.revision === state.revision);
  if (!candidate) return { ok: false, reason: 'The approved plan is out of date. Approve the latest plan first.' };

  const unknownShared = candidate.costs.filter((c) => c.allocation === 'equal_shared' && c.priceStatus === 'unknown' && c.essential !== false);
  if (unknownShared.length > 0) {
    return { ok: false, reason: 'A shared cost still has no confirmed price, so I can\'t say what each person\'s share should be yet.' };
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

const usable = (amount: number) => Number.isFinite(amount) && amount >= 0;

const COST_CATEGORIES: readonly CostCategory[] = ['accommodation', 'fuel_parking_tolls', 'food', 'activities', 'taxes_fees', 'other'];

export interface Purchase {
  id?: string;
  /** Whose bank account it came from. */
  memberId?: MemberId;
  /** The day it happened, YYYY-MM-DD. */
  date?: string;
  amountDollars: number;
  /** A plan category, or a bank's merchant category. */
  category?: string;
  status?: string;
}

export interface CategorySpend {
  category: CostCategory;
  plannedDollars: number;
  spentDollars: number;
  /** `near` is 80% of the budget or more. `over` includes spending in a category the plan never budgeted. */
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

/** Shared spending against what the plan budgeted for it, by category. */
/** A plan category from a purchase's own category or its merchant's; undefined when it cannot be told, never guessed. */
export function categoryOfPurchase(purchase: Pick<Purchase, 'category'>): CostCategory | undefined {
  const raw = purchase.category?.trim().toLowerCase();
  return COST_CATEGORIES.find((c) => c === raw) ?? categoryForMerchant(purchase.category);
}

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
    const category = categoryOfPurchase(purchase);
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


// ---- who covered what --------------------------------------------------------------------------------------

/** Food is bought by the person eating it unless someone says they covered the group, so by default it is personal and never split. */
const PERSONAL_CATEGORIES: ReadonlySet<CostCategory> = new Set<CostCategory>(['food']);

export interface CoverageOptions {
  /** Only purchases on or after this day (YYYY-MM-DD) count. A purchase with no date always counts. */
  from?: string;
  /** Only purchases on or before this day count. */
  to?: string;
  /** Purchases the group said were for everyone even though their category is personal ("I covered dinner for all of us"). */
  sharedPurchaseIds?: ReadonlySet<string>;
}

export interface MemberCoverage {
  memberId: MemberId;
  /** What this person paid for in shared categories. */
  coveredDollars: number;
  byCategory: { category: CostCategory; dollars: number }[];
  /** An equal share of everything shared, in whole dollars. The shares always add up to the total. */
  fairShareDollars: number;
  /** Covered minus fair share. Positive means the others owe them; negative means they owe the others. */
  netDollars: number;
}

export interface Transfer {
  fromMemberId: MemberId;
  toMemberId: MemberId;
  dollars: number;
}

export interface TripLedger {
  perMember: MemberCoverage[];
  sharedSpentDollars: number;
  /** The fewest-ish payments that would make everyone even. Calculated only: the bot never moves money. */
  transfers: Transfer[];
  /** Shared spending against the plan's budget, for the calm heads-ups. */
  spend: SpendReport;
  /** Food and other personal spending: not split, not counted against anyone. */
  personalDollars: number;
  /** Spending whose category could not be told. Left out of the split rather than guessed. */
  unclassifiedDollars: number;
  /** Purchases from an account that is not anyone on this trip. Never credited to a person. */
  unattributedDollars: number;
  /** Purchases dated outside the trip's period. */
  outsideTripDollars: number;
}

/**
 * Who covered what, and who would owe whom. Only shared categories (lodging, gas and parking, activities) are split
 * equally; food stays personal unless the group said otherwise. A purchase counts once (by id), only if it completed, only
 * inside the trip's period, and only for someone on the trip. Everything is whole dollars and the numbers always add up:
 * the fair shares sum to the shared total, the nets sum to zero, and the transfers settle every net exactly.
 */
export function trackCoverage(plan: Extract<ContributionPlan, { ok: true }>, purchases: readonly Purchase[], options: CoverageOptions = {}): TripLedger {
  const ids = plan.requests.map((r) => r.memberId);
  const covered = new Map<MemberId, Map<CostCategory, number>>(ids.map((id) => [id, new Map()]));
  const seen = new Set<string>();
  const shared: Purchase[] = [];
  let personal = 0, unclassified = 0, unattributed = 0, outside = 0;
  for (const purchase of purchases) {
    if (purchase.id !== undefined) {
      if (seen.has(purchase.id)) continue;
      seen.add(purchase.id);
    }
    if (purchase.status !== undefined && purchase.status !== 'completed') continue;
    if (!usable(purchase.amountDollars)) continue;
    if (purchase.date !== undefined && ((options.from !== undefined && purchase.date < options.from) || (options.to !== undefined && purchase.date > options.to))) { outside += purchase.amountDollars; continue; }
    const mine = purchase.memberId === undefined ? undefined : covered.get(purchase.memberId);
    if (!mine) { unattributed += purchase.amountDollars; continue; }
    const category = categoryOfPurchase(purchase);
    if (category === undefined) { unclassified += purchase.amountDollars; continue; }
    if (PERSONAL_CATEGORIES.has(category) && !(purchase.id !== undefined && options.sharedPurchaseIds?.has(purchase.id))) { personal += purchase.amountDollars; continue; }
    mine.set(category, (mine.get(category) ?? 0) + purchase.amountDollars);
    shared.push(purchase);
  }
  const totals = ids.map((id) => [...covered.get(id)!.values()].reduce((a, b) => a + b, 0));
  const sharedSpent = totals.reduce((a, b) => a + b, 0);
  const base = ids.length === 0 ? 0 : Math.floor(sharedSpent / ids.length);
  const extra = ids.length === 0 ? 0 : sharedSpent - base * ids.length;
  const perMember: MemberCoverage[] = ids.map((memberId, i) => {
    const fairShareDollars = base + (i < extra ? 1 : 0);
    return {
      memberId,
      coveredDollars: totals[i]!,
      byCategory: COST_CATEGORIES.filter((c) => covered.get(memberId)!.has(c)).map((category) => ({ category, dollars: covered.get(memberId)!.get(category)! })),
      fairShareDollars,
      netDollars: totals[i]! - fairShareDollars,
    };
  });
  const owes = perMember.filter((m) => m.netDollars < 0).map((m) => ({ id: m.memberId, left: -m.netDollars })).sort((a, b) => b.left - a.left);
  const owed = perMember.filter((m) => m.netDollars > 0).map((m) => ({ id: m.memberId, left: m.netDollars })).sort((a, b) => b.left - a.left);
  const transfers: Transfer[] = [];
  while (owes.length > 0 && owed.length > 0) {
    const from = owes[0]!, to = owed[0]!;
    const dollars = Math.min(from.left, to.left);
    transfers.push({ fromMemberId: from.id, toMemberId: to.id, dollars });
    from.left -= dollars; to.left -= dollars;
    if (from.left === 0) owes.shift();
    if (to.left === 0) owed.shift();
    owes.sort((a, b) => b.left - a.left); owed.sort((a, b) => b.left - a.left);
  }
  return { perMember, sharedSpentDollars: sharedSpent, transfers, spend: spendVsPlan(plan, shared), personalDollars: personal, unclassifiedDollars: unclassified, unattributedDollars: unattributed, outsideTripDollars: outside };
}

/** What the page and chat say about the trip's money: `settled` once everyone is even and something was shared, otherwise still `tracking`. */
export function ledgerStatus(ledger: TripLedger): 'tracking' | 'settled' {
  return ledger.sharedSpentDollars > 0 && ledger.transfers.length === 0 ? 'settled' : 'tracking';
}

// ---- what the bot says about who covered what ---------------------------------------------------------------

const nameIn = (state: TripState, id: MemberId) => state.roster.find((m) => m.memberId === id)?.displayName ?? id;
const owesText = (state: TripState, transfers: readonly Transfer[]) => list(transfers.slice(0, 3).map((t) => `${nameIn(state, t.fromMemberId)} owes ${nameIn(state, t.toMemberId)} ${money(t.dollars)}`)) + (transfers.length > 3 ? ` and ${transfers.length - 3} more` : '');

/**
 * The answer to "who covered what?": what each person has paid for, and who owes whom right now. At most three short
 * lines. Shared categories only, so nothing about personal spending, and never anyone's limit.
 */
export function describeCoverage(state: TripState, plan: Extract<ContributionPlan, { ok: true }>, ledger: TripLedger, options: { simulated?: boolean } = {}): string {
  const lines: string[] = [];
  const expectedEach = plan.requests[0]?.dollars;
  if (ledger.sharedSpentDollars === 0) {
    lines.push(`Nothing shared has been covered yet.${expectedEach !== undefined ? ` The plan expects about ${money(expectedEach)} each in shared costs.` : ''} Whoever pays, I'll track it.`);
  } else {
    const each = ledger.perMember[0]?.fairShareDollars ?? 0;
    lines.push(`Covered so far: ${list(ledger.perMember.map((m) => `${nameIn(state, m.memberId)} ${money(m.coveredDollars)}`))}. Fair share is about ${money(each)} each.`);
    lines.push(ledger.transfers.length === 0 ? "Everyone's even right now." : `Right now ${owesText(state, ledger.transfers)}.`);
  }
  if (options.simulated) lines[lines.length - 1] += ' (Simulated money.)';
  return lines.join('\n');
}

/** A private nudge for one person about what they owe. Nothing about anyone else's own spending; undefined if they owe nothing. */
export function settleUpFor(state: TripState, memberId: MemberId, ledger: TripLedger): string | undefined {
  const mine = ledger.transfers.filter((t) => t.fromMemberId === memberId);
  if (mine.length === 0) return undefined;
  return `Settling up so far: you owe ${list(mine.map((t) => `${nameIn(state, t.toMemberId)} ${money(t.dollars)}`))}.`;
}

/** The wrap-up for the group: the shared total, each person's share, and who sends whom. It only calculates. */
export function describeWrapUp(state: TripState, ledger: TripLedger, options: { simulated?: boolean } = {}): string {
  const lines: string[] = [];
  if (ledger.sharedSpentDollars === 0) lines.push('Trip wrap-up: nothing shared was covered, so nobody owes anyone.');
  else {
    const each = ledger.perMember[0]?.fairShareDollars ?? 0;
    lines.push(`Trip wrap-up: ${money(ledger.sharedSpentDollars)} of shared costs, about ${money(each)} each.`);
    lines.push(ledger.transfers.length === 0 ? "Everyone covered their share, so nobody owes anyone." : `To settle: ${ledger.transfers.map((t) => `${nameIn(state, t.fromMemberId)} sends ${nameIn(state, t.toMemberId)} ${money(t.dollars)}`).join(', ')}.`);
  }
  const notes: string[] = [];
  if (ledger.unclassifiedDollars > 0) notes.push(`${money(ledger.unclassifiedDollars)} had no category, so I left it out.`);
  if (ledger.unattributedDollars > 0) notes.push(`${money(ledger.unattributedDollars)} came from an account that isn't on this trip.`);
  if (notes.length > 0) lines.push(notes.join(' '));
  lines.push(`I don't move any money, so you'd send these yourselves.${options.simulated ? ' (Simulated money.)' : ''}`);
  return lines.join('\n');
}
