import type { EvidenceKind, SourceEvidence } from '../planning/types.js';
import { ResearchError, type ResearchOption, type ResearchResult } from './types.js';

const KINDS: readonly EvidenceKind[] = ['official', 'community', 'estimate', 'web'];
const MAX_CLAIM = 500;
const MAX_TITLE = 200;

/** Fixture URLs use the reserved `.invalid` top level, so a fixture link can never be mistaken for a real source. */
export const FIXTURE_HOST_SUFFIX = '.invalid';

export function isFixtureEvidence(evidence: SourceEvidence): boolean {
  try {
    return new URL(evidence.url).hostname.endsWith(FIXTURE_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * Retrieved text is data, never instructions. Strip control characters, flatten whitespace and bound the
 * length so a page cannot smuggle formatting, hidden text or an essay into a chat message.
 */
export function sanitizeRetrievedText(text: string, max = MAX_CLAIM): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const hasOffset = (iso: string) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
const validTime = (value: unknown): value is string => typeof value === 'string' && hasOffset(value) && Number.isFinite(Date.parse(value));

/** Why this evidence record is not acceptable, or `undefined` if it is. */
export function evidenceProblem(evidence: SourceEvidence): string | undefined {
  if (typeof evidence.evidenceId !== 'string' || evidence.evidenceId === '') return 'it has no evidence ID';
  let url: URL;
  try {
    url = new URL(evidence.url);
  } catch {
    return `${evidence.evidenceId} has no valid URL`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${evidence.evidenceId} is not a web link`;
  if (typeof evidence.title !== 'string' || evidence.title.trim() === '') return `${evidence.evidenceId} has no title`;
  if (!KINDS.includes(evidence.kind)) return `${evidence.evidenceId} has an unknown kind`;
  if (typeof evidence.claim !== 'string' || evidence.claim.trim() === '') return `${evidence.evidenceId} states no claim`;
  if (!validTime(evidence.retrievedAt)) return `${evidence.evidenceId} has no valid retrieval time`;
  if (evidence.publishedAt !== undefined && !validTime(evidence.publishedAt)) return `${evidence.evidenceId} has an invalid publication date`;
  return undefined;
}

/** Clean an evidence record from a provider. Nothing is invented: a missing field stays missing and fails validation. */
export function cleanEvidence(evidence: SourceEvidence): SourceEvidence {
  return {
    ...evidence,
    title: typeof evidence.title === 'string' ? sanitizeRetrievedText(evidence.title, MAX_TITLE) : evidence.title,
    claim: typeof evidence.claim === 'string' ? sanitizeRetrievedText(evidence.claim) : evidence.claim,
    ...(evidence.uncertainty !== undefined ? { uncertainty: sanitizeRetrievedText(evidence.uncertainty) } : {}),
  };
}

const invalid = (message: string): never => {
  throw new ResearchError('invalid_result', `The research results weren't usable: ${message}`);
};

function checkOption(option: ResearchOption, known: ReadonlySet<string>, live: boolean): void {
  const refs = [
    ...option.evidenceIds,
    ...option.stops.flatMap((s) => s.evidenceIds),
    ...option.costs.flatMap((c) => c.evidenceIds),
    ...option.perPersonCosts.flatMap((c) => c.evidenceIds),
  ];
  for (const id of refs) if (!known.has(id)) invalid(`${option.name} cites ${id}, which isn't in the sources`);
  const costIds = new Set<string>();
  for (const cost of [...option.costs, ...option.perPersonCosts]) {
    if (costIds.has(cost.costId)) invalid(`${option.name} lists cost ${cost.costId} twice`);
    costIds.add(cost.costId);
  }
  // A claim that a price is verified has to rest on an official source.
  for (const cost of [...option.costs, ...option.perPersonCosts]) {
    if (cost.priceStatus === 'verified' && cost.evidenceIds.length === 0) invalid(`${cost.label} is marked verified but cites no source`);
  }
  if (live && option.evidenceIds.length === 0) {
    throw new ResearchError('unsourced', `I found "${option.name}" without a source I can show you, so I'm not using it.`);
  }
}

/**
 * Check a provider result and return it cleaned. Throws `ResearchError` rather than passing along anything
 * that is unsourced, malformed or mislabeled:
 * - every evidence record has a real link, title, claim and retrieval time, and IDs are unique;
 * - everything an option cites exists, and a "verified" price cites a source;
 * - a `live` result may not contain fixture sources, and live options must each cite a source;
 * - a `fixture` result is only fixture sources, so offline data can't pass for live research.
 */
export function validateResult(result: ResearchResult): ResearchResult {
  if (result.mode !== 'fixture' && result.mode !== 'live') invalid('the result does not say whether it is live or fixture data');
  if (!Number.isInteger(result.revision)) invalid('the result does not say which plan revision it is for');
  if (!validTime(result.retrievedAt)) invalid('the result has no valid retrieval time');

  const evidence = result.evidence.map(cleanEvidence);
  const known = new Set<string>();
  for (const e of evidence) {
    const problem = evidenceProblem(e);
    if (problem) invalid(problem);
    if (known.has(e.evidenceId)) invalid(`source ${e.evidenceId} appears twice`);
    known.add(e.evidenceId);
    const fixture = isFixtureEvidence(e);
    if (result.mode === 'live' && fixture) invalid('live research contains a fixture source');
    if (result.mode === 'fixture' && !fixture) invalid('fixture research contains a source that looks real');
  }
  const live = result.mode === 'live';
  for (const option of result.options) checkOption(option, known, live);
  return { ...result, evidence };
}

/** How a source should be worded to the group: experiences are attributed, estimates are called estimates. */
export function describeEvidence(evidence: SourceEvidence): string {
  const claim = evidence.claim.replace(/[.\s]+$/, '');
  const fixture = isFixtureEvidence(evidence) ? ' [fixture data, not a real source]' : '';
  switch (evidence.kind) {
    case 'official':
      return `${claim} (${evidence.title})${fixture}`;
    case 'community':
      return `One community post reports: ${claim} (${evidence.title}); this is one person's experience, not a verified fact${fixture}`;
    case 'estimate':
      return `Estimate: ${claim}, not a verified price${fixture}`;
    default:
      return `${claim} (${evidence.title}, unverified)${fixture}`;
  }
}
