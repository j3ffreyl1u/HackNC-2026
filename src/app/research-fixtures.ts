import { defaultFixtures } from '../research/fixtures.js';
import type { FixtureData } from '../research/fixtures.js';

/** C's extra offline guide fixture: a free stop remains feasible at the exact cap. */
export const demoResearchFixtures: FixtureData = {
  evidence: [...defaultFixtures.evidence, { evidenceId: 'fx-free-indoor', url: 'https://fixtures.invalid/free-indoor', title: 'FIXTURE: Free indoor visitor display', retrievedAt: '2026-10-10T12:00:00Z', kind: 'estimate', claim: 'Synthetic visitor display with no admission cost.', uncertainty: 'Fixture only; no actual venue or availability is asserted.' }],
  options: [...defaultFixtures.options, { optionId: 'free-indoor', name: 'Free indoor visitor display', region: 'NC mountains', tags: ['rain', 'indoor'], driveMinutesFromOrigin: 150,
    stops: [{ label: 'Visitor display', location: 'Nearby small town', tags: ['indoor'], hours: 1, evidenceIds: ['fx-free-indoor'] }],
    costs: [{ costId: 'free-display', category: 'activities', label: 'Fixture admission', lowCents: 0, highCents: 0, allocation: 'equal_shared', evidenceIds: ['fx-free-indoor'], priceStatus: 'estimate' }], perPersonCosts: [], evidenceIds: ['fx-free-indoor'], tradeoffs: ['Synthetic free indoor alternative; opening hours are unverified.'] }],
};
