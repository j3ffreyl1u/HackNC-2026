import type { TripState } from '../contracts/index.js';
import { toPlanningState } from '../app/planning-adapter.js';
import { planContributions, checkFunding, spendVsPlan } from '../planning/funding.js';
import type { FundReader } from './nessie-reader.js';

export function createFundService(reader: FundReader, mode: 'mock' | 'nessie', boundRevision?: number) {
  return {
    /** Full member report is for private chat routing; never serialize it to the public viewer. */
    async inspect(state: TripState) {
      const plan = planContributions(toPlanningState(state));
      if (!plan.ok) return { status: 'not_ready' as const, reason: plan.reason, mode, revision: state.revision };
      if (mode === 'nessie' && boundRevision !== plan.revision) return { status: 'not_ready' as const, reason: 'Bind a dedicated sandbox account to this approved revision before reading the fund.', mode, revision: state.revision };
      const ledger = await reader.read();
      const funding = checkFunding(plan, ledger.deposits);
      const spending = spendVsPlan(plan, ledger.purchases);
      return { status: funding.status, mode, revision: plan.revision, plan, funding, spending, remainingDollars: funding.collectedDollars - spending.totalSpentDollars };
    },
    async publicView(state: TripState) {
      const result = await this.inspect(state);
      if (!result.funding) return result;
      return { status: result.status, mode, revision: result.revision, neededDollars: result.funding.neededDollars, collectedDollars: result.funding.collectedDollars, remainingDollars: result.remainingDollars, missingCount: result.funding.missingMemberIds.length, staleDollars: result.funding.staleDollars, unattributedDollars: result.funding.unattributedDollars, spending: result.spending };
    },
  };
}
export type FundService = ReturnType<typeof createFundService>;
