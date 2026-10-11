import type { CostItem, SourceEvidence } from '../planning/types.js';
import { sanitizeRetrievedText } from './evidence.js';
import type { ResearchOption, ResearchRequest, ResearchResult } from './types.js';

// Curated offline research for mock mode. Every source uses a reserved `.invalid` host and says so in its
// title: these are synthetic claims for tests and the demo, not real prices, closures or opinions.

export interface FixtureData {
  evidence: SourceEvidence[];
  options: ResearchOption[];
}

const FIXTURE_TIME = '2026-10-01T00:00:00.000Z';
const NOTE = 'Fixture: a synthetic claim for offline testing, not a real source.';

const source = (id: string, kind: SourceEvidence['kind'], title: string, claim: string): SourceEvidence => ({
  evidenceId: id,
  url: `https://fixtures.invalid/${id}`,
  title: `FIXTURE: ${title}`,
  retrievedAt: FIXTURE_TIME,
  kind,
  claim,
  uncertainty: NOTE,
});

const shared = (costId: string, category: CostItem['category'], label: string, low: number, high: number, status: CostItem['priceStatus'], evidenceIds: string[]): CostItem => ({
  costId, category, label, lowCents: low, highCents: high, allocation: 'equal_shared', evidenceIds, priceStatus: status,
});

export const FIXTURE_EVIDENCE: SourceEvidence[] = [
  source('fx-trails', 'official', 'Park trail information', 'Trails in the area are open for day hikes; current trail conditions should be checked before going.'),
  source('fx-leaf-season', 'community', 'Trip report: October weekend', 'A traveler reports that cabin rates near the mountains were higher during October leaf season and sold out early.'),
  source('fx-fuel', 'estimate', 'Fuel cost estimate', 'Fuel and parking assume a round trip in one car at typical mileage and fuel prices; actual cost varies.'),
  source('fx-parkway', 'official', 'Scenic road status', 'Sections of the scenic road can close in bad weather; check current status before driving.'),
  source('fx-rain-museum', 'community', 'Rainy-day report', 'One visitor reports the town museum was a good rainy-day stop; another said it was crowded on a Saturday.'),
  source('fx-rain-crowded', 'community', 'Rainy-day report 2', 'A different visitor says weekday mornings are quieter at indoor attractions when it rains.'),
  source('fx-food', 'estimate', 'Food cost estimate', 'Food for the weekend assumes two restaurant meals and the rest self-catered; actual cost varies.'),
];

const food = {
  costId: 'food', category: 'food' as const, label: 'Food', lowCents: 1_500, highCents: 2_000,
  evidenceIds: ['fx-food'], priceStatus: 'estimate' as const,
};

export const FIXTURE_OPTIONS: ResearchOption[] = [
  {
    optionId: 'boone-cabin',
    name: 'Mountain cabin weekend',
    region: 'NC mountains',
    tags: ['hiking', 'mountains', 'views'],
    driveMinutesFromOrigin: 180,
    stops: [
      { label: 'Drive to the mountains', location: 'Boone, NC', tags: [], travelMinutesFromPrevious: 180, hours: 3, evidenceIds: ['fx-fuel'] },
      { label: 'Day hike', location: 'Grandfather Mountain area', tags: ['hiking', 'views'], travelMinutesFromPrevious: 30, hours: 6, evidenceIds: ['fx-trails'] },
    ],
    costs: [
      shared('lodging', 'accommodation', 'Cabin, two nights', 30_000, 36_000, 'estimate', ['fx-leaf-season']),
      shared('fuel', 'fuel_parking_tolls', 'Fuel and parking', 4_800, 6_000, 'estimate', ['fx-fuel']),
      shared('activities', 'activities', 'Park and trail fees', 4_000, 6_000, 'estimate', ['fx-trails']),
    ],
    perPersonCosts: [food],
    suggestedContingencyPerPersonCents: 1_000,
    evidenceIds: ['fx-trails', 'fx-leaf-season', 'fx-fuel', 'fx-parkway'],
    tradeoffs: ['Best views, but the longest drive and the highest cabin prices.'],
  },
  {
    optionId: 'hanging-rock',
    name: 'State park and small-town weekend',
    region: 'NC mountains',
    tags: ['hiking', 'town visit', 'mountains'],
    driveMinutesFromOrigin: 150,
    stops: [
      { label: 'Drive to the park', location: 'Hanging Rock area', tags: [], travelMinutesFromPrevious: 150, hours: 2.5, evidenceIds: ['fx-fuel'] },
      { label: 'Day hike', location: 'State park', tags: ['hiking'], travelMinutesFromPrevious: 20, hours: 5, evidenceIds: ['fx-trails'] },
      { label: 'Evening in town', location: 'Nearby small town', tags: ['town visit'], travelMinutesFromPrevious: 25, hours: 3, evidenceIds: ['fx-rain-museum'] },
    ],
    costs: [
      shared('lodging', 'accommodation', 'Lodging, two nights', 28_000, 33_000, 'estimate', ['fx-leaf-season']),
      shared('fuel', 'fuel_parking_tolls', 'Fuel and parking', 4_500, 5_500, 'estimate', ['fx-fuel']),
      shared('activities', 'activities', 'Park and museum fees', 5_000, 6_500, 'estimate', ['fx-trails']),
    ],
    perPersonCosts: [food],
    suggestedContingencyPerPersonCents: 1_000,
    evidenceIds: ['fx-trails', 'fx-leaf-season', 'fx-fuel', 'fx-rain-museum'],
    tradeoffs: ['Shorter drive and a town visit, with less dramatic views.'],
  },
  {
    optionId: 'asheville',
    name: 'City and brewery weekend',
    region: 'NC mountains',
    tags: ['town visit', 'breweries', 'food'],
    driveMinutesFromOrigin: 220,
    stops: [
      { label: 'Drive to the city', location: 'Asheville, NC', tags: [], travelMinutesFromPrevious: 220, hours: 3.7, evidenceIds: ['fx-fuel'] },
      { label: 'Brewery walk', location: 'Downtown', tags: ['breweries', 'town visit'], travelMinutesFromPrevious: 10, hours: 4, evidenceIds: [] },
    ],
    costs: [
      // The lodging price is genuinely unknown: this option can be shown as provisional but never as affordable.
      shared('lodging', 'accommodation', 'Lodging, two nights', 0, 0, 'unknown', []),
      shared('fuel', 'fuel_parking_tolls', 'Fuel and parking', 6_000, 7_500, 'estimate', ['fx-fuel']),
    ],
    perPersonCosts: [food],
    evidenceIds: ['fx-fuel', 'fx-food'],
    tradeoffs: ['Lodging prices weren\'t found, so the cost is unverified.'],
  },
  {
    optionId: 'rainy-day-boone',
    name: 'Rainy-day indoor stops',
    region: 'NC mountains',
    tags: ['rain', 'indoor', 'museum'],
    driveMinutesFromOrigin: 180,
    stops: [{ label: 'Town museum', location: 'Boone, NC', tags: ['indoor', 'museum'], travelMinutesFromPrevious: 15, hours: 2, evidenceIds: ['fx-rain-museum', 'fx-rain-crowded'] }],
    costs: [shared('museum', 'activities', 'Museum entry', 1_800, 3_000, 'estimate', ['fx-rain-museum'])],
    perPersonCosts: [],
    evidenceIds: ['fx-rain-museum', 'fx-rain-crowded'],
    tradeoffs: ['Sources disagree on crowding: one says busy on Saturday, another says weekday mornings are quiet.'],
  },
];

export const defaultFixtures: FixtureData = { evidence: FIXTURE_EVIDENCE, options: FIXTURE_OPTIONS };

const words = (text: string) => sanitizeRetrievedText(text, 300).toLowerCase().match(/[a-z]+/g) ?? [];

/**
 * Deterministic offline search. It filters by the stated destination, region and drive limit, and orders by how
 * many of the group's interests an option covers. It never invents anything the fixture does not contain.
 */
export function searchFixtures(data: FixtureData, request: ResearchRequest, retrievedAt: string): ResearchResult {
  const interests = new Set(request.interests.map((i) => i.toLowerCase()));
  const destination = request.destination?.toLowerCase();
  const region = request.searchRegion?.toLowerCase();
  const questionWords = new Set(request.purpose === 'guide' && request.question ? words(request.question) : []);
  const rainy = ['rain', 'rains', 'rained', 'raining', 'rainy', 'rainstorm', 'drizzle', 'shower', 'showers', 'wet', 'storm', 'storms', 'stormy', 'thunderstorm'].some((w) => questionWords.has(w));

  const matches = data.options.filter((o) => {
    const isGuideOnly = o.tags.includes('rain');
    if (request.purpose === 'plan' && isGuideOnly) return false;
    // Guide questions are answered only from sources about the question; the fixture knows only about rain.
    if (request.purpose === 'guide' && !(isGuideOnly && rainy)) return false;
    if (destination && !`${o.name} ${o.region} ${o.stops.map((s) => s.location).join(' ')}`.toLowerCase().includes(destination)) return false;
    if (!destination && region && !o.region.toLowerCase().includes(region)) return false;
    if (request.maxTravelMinutes !== undefined && o.driveMinutesFromOrigin !== undefined && o.driveMinutesFromOrigin > request.maxTravelMinutes) return false;
    return true;
  });
  const overlap = (o: ResearchOption) => o.tags.filter((t) => interests.has(t)).length;
  const options = [...matches].sort((a, b) => overlap(b) - overlap(a) || a.optionId.localeCompare(b.optionId));

  const cited = new Set(options.flatMap((o) => [...o.evidenceIds, ...o.stops.flatMap((s) => s.evidenceIds), ...o.costs.flatMap((c) => c.evidenceIds), ...o.perPersonCosts.flatMap((c) => c.evidenceIds)]));
  const limitations = ['These results are fixture data for offline testing: dates, prices and sources are synthetic.'];
  if (options.length === 0) limitations.push('No fixture option matched the destination, region and drive limit.');
  if (options.some((o) => o.costs.some((c) => c.priceStatus === 'unknown'))) limitations.push('Some prices were not found and are marked unknown.');
  limitations.push('Availability was not checked for any option.');
  return {
    mode: 'fixture',
    revision: request.revision,
    retrievedAt,
    options: options.map((o) => structuredClone(o)),
    evidence: data.evidence.filter((e) => cited.has(e.evidenceId)).map((e) => ({ ...e })),
    limitations,
  };
}
