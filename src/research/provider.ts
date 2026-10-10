import { validateResult } from './evidence.js';
import { ResearchError, type ResearchProvider, type ResearchRequest, type ResearchResult } from './types.js';
import type { FixtureData } from './fixtures.js';
import { searchFixtures } from './fixtures.js';

/** Curated offline data. Always labeled `fixture`, and its sources use reserved `.invalid` links. */
export function createFixtureProvider(data: FixtureData, now: () => string = () => new Date().toISOString()): ResearchProvider {
  return {
    mode: 'fixture',
    async search(request: ResearchRequest): Promise<ResearchResult> {
      return validateResult(searchFixtures(data, request, now()));
    },
  };
}

/**
 * Wrap a live provider so that nothing unchecked reaches the planner: results are validated, and any
 * failure becomes a `ResearchError` the caller must show. There is no fallback to fixture facts.
 */
export function guardLiveProvider(live: ResearchProvider): ResearchProvider {
  return {
    mode: 'live',
    async search(request: ResearchRequest): Promise<ResearchResult> {
      let result: ResearchResult;
      try {
        result = await live.search(request);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw new ResearchError('request_failed', "I couldn't reach the research service just now. You can try again, or give me details yourselves.", { cause: error });
      }
      if (result.mode !== 'live') {
        throw new ResearchError('invalid_result', "The research service returned data that isn't live, so I'm not using it.");
      }
      return validateResult(result);
    },
  };
}

export interface ResearchConfig {
  /** Chosen explicitly, e.g. from `RESEARCH_MODE`. Neither mode ever stands in for the other. */
  mode: 'mock' | 'live';
  fixtures?: FixtureData;
  live?: ResearchProvider;
}

export function createResearchProvider(config: ResearchConfig): ResearchProvider {
  if (config.mode === 'mock') {
    if (!config.fixtures) throw new ResearchError('not_configured', 'Mock research needs fixture data.');
    return createFixtureProvider(config.fixtures);
  }
  if (!config.live) {
    const unavailable: ResearchProvider = {
      mode: 'live',
      async search() {
        throw new ResearchError('not_configured', "Live research isn't set up yet, so I can't look up real options. You can give me details yourselves.");
      },
    };
    return unavailable;
  }
  return guardLiveProvider(config.live);
}
