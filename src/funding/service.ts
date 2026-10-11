import type { TripState } from '../contracts/index.js';
import { toPlanningState } from '../app/planning-adapter.js';
import { ledgerStatus, planContributions, reviewPurchases, trackCoverage, type PurchaseAnswer } from '../planning/funding.js';
import type { FundReader, FundLedger } from './nessie-reader.js';

const DAY_MS = 86_400_000;
/** Purchases a little after the trip (a last tank of gas, checkout fees) still belong to it. */
const GRACE_DAYS = 2;

/**
 * The period whose purchases belong to this trip: from the day everyone agreed to the plan (bookings made before the
 * trip count) until a couple of days after it ends. Spending outside it is somebody's normal life, not the trip.
 */
export function tripPeriod(state: TripState): { from?: string; to?: string } {
  const chosen = state.candidates.find((c) => c.candidateId === state.selectedCandidateId && c.revision === state.revision);
  const agreed = state.acceptances.filter((a) => a.candidateId === state.selectedCandidateId && a.revision === state.revision).map((a) => Date.parse(a.acceptedAt)).filter(Number.isFinite);
  const end = chosen ? Date.parse(chosen.endAt) : Number.NaN;
  return {
    ...(agreed.length > 0 ? { from: new Date(Math.max(...agreed)).toISOString().slice(0, 10) } : {}),
    ...(Number.isFinite(end) ? { to: new Date(end + GRACE_DAYS * DAY_MS).toISOString().slice(0, 10) } : {}),
  };
}

export function createFundService(reader: FundReader, mode: 'mock' | 'nessie', options: { now?: () => number; cacheMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 30_000;
  if (!Number.isFinite(cacheMs) || cacheMs < 0) throw new Error('Fund cache duration must be nonnegative.');
  let cached: { ledger: FundLedger; expiresAt: number } | undefined;
  let pending: Promise<FundLedger> | undefined;
  const readLedger = async () => {
    if (cached && now() < cached.expiresAt) return cached.ledger;
    if (!pending) pending = reader.read().then(ledger => {
      cached = { ledger, expiresAt: now() + cacheMs };
      return ledger;
    }).finally(() => { pending = undefined; });
    return pending;
  };
  return {
    /** Everything, including who covered what, for private chat routing. */
    async inspect(state: TripState) {
      const plan = planContributions(toPlanningState(state));
      if (!plan.ok) return { status: 'not_ready' as const, reason: plan.reason, mode, revision: state.revision };
      const ledger = await readLedger();
      const period = tripPeriod(state);
      const answers: Record<string, PurchaseAnswer> = {};
      for (const [id, check] of Object.entries(state.purchaseChecks ?? {})) if (check.status !== 'asked') answers[id] = check.status;
      const review = reviewPurchases(plan, ledger.purchases, answers, period);
      // A purchase its buyer said was for everyone ("trip") is split even when its category (food) normally is not.
      const sharedPurchaseIds = new Set(Object.entries(answers).filter(([, answer]) => answer === 'trip').map(([id]) => id));
      const coverage = trackCoverage(plan, review.counted, { ...period, sharedPurchaseIds });
      return { status: ledgerStatus(coverage), mode, revision: plan.revision, plan, coverage, toCheck: review.flagged };
    },
    /**
     * What the shared page may show: first names, what each person covered in the shared categories, who owes whom, and
     * the plan's budget by category. Never a limit, and never personal spending.
     */
    async publicView(state: TripState) {
      const result = await this.inspect(state);
      if (!result.coverage) return result;
      const { coverage, plan } = result;
      const name = (id: string) => state.roster?.find((m) => m.memberId === id)?.displayName ?? id;
      return {
        status: result.status, mode, revision: result.revision,
        expectedEachDollars: plan.requests[0]?.dollars ?? 0,
        sharedSpentDollars: coverage.sharedSpentDollars,
        members: coverage.perMember.map((m) => ({ memberId: m.memberId, name: name(m.memberId), coveredDollars: m.coveredDollars, fairShareDollars: m.fairShareDollars, netDollars: m.netDollars, byCategory: m.byCategory })),
        transfers: coverage.transfers.map((t) => ({ from: name(t.fromMemberId), to: name(t.toMemberId), dollars: t.dollars })),
        spending: coverage.spend,
        unclassifiedDollars: coverage.unclassifiedDollars,
        unattributedDollars: coverage.unattributedDollars,
        awaitingConfirmationDollars: result.toCheck.reduce((sum, f) => sum + f.purchase.amountDollars, 0),
      };
    },
  };
}
export type FundService = ReturnType<typeof createFundService>;
