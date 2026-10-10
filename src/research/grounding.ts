import type { SourceEvidence } from '../planning/types.js';
import { sanitizeRetrievedText } from './evidence.js';

// Reading grounded Gemini answers: text blocks, their citations, and turning citations into evidence records.
// Shared by the research parser and the price lookups.

export interface Annotation {
  url: string;
  title?: string;
  start: number;
  end: number;
}
export interface TextBlock {
  text: string;
  annotations: Annotation[];
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Citation offsets in grounding responses count UTF-8 bytes (the same as characters for plain ASCII, which is
 * all live testing has shown so far). When the text has other characters, convert so a citation still lands on
 * the line it belongs to.
 */
function toCharOffsets(text: string, annotations: Annotation[]): Annotation[] {
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u007f]*$/.test(text)) return annotations;
  const bytes = Buffer.from(text, 'utf8');
  const toChar = (offset: number) => bytes.subarray(0, Math.max(0, Math.min(offset, bytes.length))).toString('utf8').length;
  return annotations.map((a) => ({ ...a, start: toChar(a.start), end: toChar(a.end) }));
}

export function textBlocks(interaction: unknown): { blocks: TextBlock[]; suggestions: string[] } {
  const steps = isRecord(interaction) && Array.isArray(interaction.steps) ? interaction.steps : [];
  const blocks: TextBlock[] = [];
  const suggestions: string[] = [];
  for (const step of steps) {
    if (!isRecord(step)) continue;
    if (step.type === 'google_search_result' && Array.isArray(step.result)) {
      for (const r of step.result) if (isRecord(r) && typeof r.search_suggestions === 'string') suggestions.push(r.search_suggestions);
    }
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const item of step.content) {
      if (!isRecord(item) || typeof item.text !== 'string') continue;
      const annotations: Annotation[] = [];
      for (const a of Array.isArray(item.annotations) ? item.annotations : []) {
        if (!isRecord(a) || a.type !== 'url_citation' || typeof a.url !== 'string') continue;
        if (!Number.isInteger(a.start_index) || !Number.isInteger(a.end_index)) continue;
        annotations.push({ url: a.url, title: typeof a.title === 'string' ? a.title : undefined, start: a.start_index as number, end: a.end_index as number });
      }
      blocks.push({ text: item.text, annotations: toCharOffsets(item.text, annotations) });
    }
  }
  return { blocks, suggestions };
}

const HOSTNAME = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;

/**
 * Grounding links are Google redirect URLs, so the real site is read from the citation's title, which the API
 * sets to the site's domain. Only when the title isn't a domain is the link's own host used.
 */
/**
 * Hosts known to be discussion forums or Q&A sites, where a hit is someone's individual post, not a
 * publisher's own claim. Matched by exact domain or subdomain, never by a word like "community" appearing
 * in an unrelated hostname, so a blog is never misclassified just because of its name.
 */
const FORUM_HOSTS = [
  'reddit.com',
  'tripadvisor.com', // includes TripAdvisor's forum subpaths, which read the same as its reviews
  'quora.com',
  'flyertalk.com',
  'city-data.com',
  'thorntree.lonelyplanet.com',
  'fodors.com', // the Fodor's Travel Talk forum
  'travellerspoint.com',
];

function isForumHost(host: string): boolean {
  return FORUM_HOSTS.some((forum) => host === forum || host.endsWith(`.${forum}`));
}

export function kindOf(url: string, title: string | undefined): SourceEvidence['kind'] {
  const shown = title?.trim().toLowerCase();
  const host = shown && HOSTNAME.test(shown) ? shown.replace(/^www\./, '') : new URL(url).hostname.toLowerCase();
  if (isForumHost(host)) return 'community';
  if (host.endsWith('.gov')) return 'official';
  return 'web'; // a search hit is not known to be official, so it is never labeled so
}


/**
 * Collects evidence records across every grounded answer in one search, so IDs stay unique and the same
 * source and claim are recorded once.
 */
export class EvidenceStore {
  readonly evidence: SourceEvidence[] = [];
  private readonly ids = new Map<string, string>();

  constructor(private readonly retrievedAt: string) {}

  /** Record a citation for a claim and return its evidence ID, or `undefined` if its link is unusable. */
  add(cite: Annotation, claim: string): string | undefined {
    let url: URL;
    try {
      url = new URL(cite.url);
    } catch {
      return undefined;
    }
    const text = sanitizeRetrievedText(claim);
    const key = `${url.href}\u0000${text}`;
    const known = this.ids.get(key);
    if (known) return known;
    const id = `gem-${this.evidence.length + 1}`;
    this.ids.set(key, id);
    this.evidence.push({
      evidenceId: id,
      url: url.href,
      title: sanitizeRetrievedText(cite.title ?? url.hostname, 200),
      retrievedAt: this.retrievedAt,
      kind: kindOf(url.href, cite.title),
      claim: text,
      uncertainty: 'Found by web search and not checked against the provider; prices and availability may have changed.',
    });
    return id;
  }
}

/** Citations whose span overlaps the character range `[start, end)`. */
export function citesOver(block: TextBlock, start: number, end: number): Annotation[] {
  return block.annotations.filter((a) => a.start < end && a.end > start);
}
