import type { ItineraryItem, TripCandidate } from './types.js';

// Nature-facing facts about a plan, derived only from what the plan already carries: stop tags and the drive
// minutes written into each leg by the sources. Nothing here estimates emissions or distance on its own; it
// compares minutes and says plainly what they leave out.

const OUTDOOR_TAGS = new Set([
  'hiking', 'hike', 'trail', 'trails', 'camping', 'kayaking', 'paddling', 'canoeing', 'cycling', 'biking',
  'park', 'parks', 'nature', 'views', 'waterfall', 'lake', 'beach', 'swimming', 'mountains', 'wildlife',
]);

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export interface OutdoorSummary {
  candidateId: string;
  title: string;
  outdoorStops: Pick<ItineraryItem, 'label' | 'location'>[];
  /** Sum of the legs that have a drive time. Legs without one are counted in `unknownLegs`, never as zero. */
  drivingMinutes: number;
  unknownLegs: number;
}

export function outdoorSummary(candidate: TripCandidate): OutdoorSummary {
  const outdoorStops = candidate.itinerary
    .filter((item) => item.tags.some((t) => OUTDOOR_TAGS.has(t.trim().toLowerCase())))
    .map(({ label, location }) => ({ label, location }));
  let drivingMinutes = 0;
  let unknownLegs = 0;
  for (const item of candidate.itinerary) {
    if (item.travelMinutesFromPrevious === undefined) unknownLegs += 1;
    else drivingMinutes += item.travelMinutesFromPrevious;
  }
  return { candidateId: candidate.candidateId, title: candidate.title, outdoorStops, drivingMinutes, unknownLegs };
}

export interface DrivingComparison {
  fewestDrivingId: string;
  /** How many minutes less the best option drives than the one with the most. Zero is a tie. */
  savedMinutes: number;
  text: string;
}

/**
 * Compare the driving in the options that fit everyone. Returns nothing unless there are at least two such
 * options and every leg of each has a drive time: an unknown drive is not zero, so it is not compared.
 */
export function drivingComparison(candidates: readonly TripCandidate[]): DrivingComparison | undefined {
  const fitting = candidates.filter((c) => c.feasibility.feasible).map((c) => ({ c, s: outdoorSummary(c) }));
  if (fitting.length < 2 || fitting.some((f) => f.s.unknownLegs > 0)) return undefined;
  const sorted = [...fitting].sort((a, b) => a.s.drivingMinutes - b.s.drivingMinutes || a.c.candidateId.localeCompare(b.c.candidateId));
  const best = sorted[0]!;
  const most = sorted.at(-1)!;
  const saved = most.s.drivingMinutes - best.s.drivingMinutes;
  const label = (f: (typeof sorted)[number]) => `${f.c.title} (${formatMinutes(f.s.drivingMinutes)})`;
  const headline =
    saved === 0
      ? `These options involve the same amount of driving: ${sorted.map(label).join(' and ')}.`
      : `${label(best)} has ${formatMinutes(saved)} less driving than ${label(most)}.`;
  const demo = fitting.some((f) => f.c.dataSource === 'fixture') ? ' These are demo data.' : '';
  return {
    fewestDrivingId: best.c.candidateId,
    savedMinutes: saved,
    text: `${headline} Minutes come from the drive times in the plans' sources; the drive home is not counted.${demo}`,
  };
}
