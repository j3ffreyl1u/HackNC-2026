import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Run the real page script with a small DOM boundary double. This checks text and
// asynchronous rendering, not browser layout, CSS, canvas or accessibility.
class Element {
  children = [];
  attributes = {};
  hidden = false;
  textContent = '';
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  listeners = {};
  addEventListener(name, callback) { this.listeners[name] = callback; }
  get childElementCount() { return this.children.length; }
}
const text = (node) => [node.textContent, ...node.children.map(text)].join(' ');
const snapshot = { tripId: 'chapel-hill-weekend', revision: 12, status: 'approved', participants: [], candidates: [], acceptances: [], fundingStatus: 'tracking' };
const ledger = () => ({
  status: 'tracking', mode: 'mock', revision: 12, expectedEachDollars: 160, sharedSpentDollars: 200,
  members: [
    { memberId: 'mason', name: 'Mason', coveredDollars: 110, fairShareDollars: 67, netDollars: 43, byCategory: [{ category: 'accommodation', dollars: 110 }] },
    { memberId: 'alex', name: 'Alex', coveredDollars: 60, fairShareDollars: 67, netDollars: -7, byCategory: [{ category: 'fuel_parking_tolls', dollars: 60 }] },
    { memberId: 'jordan', name: 'Jordan', coveredDollars: 30, fairShareDollars: 66, netDollars: -36, byCategory: [{ category: 'activities', dollars: 30 }] },
  ],
  transfers: [{ from: 'Jordan', to: 'Mason', dollars: 36 }, { from: 'Alex', to: 'Mason', dollars: 7 }],
  spending: { byCategory: [], overCategories: [], unclassifiedDollars: 0, totalSpentDollars: 200, contingencyDollars: 30 },
  unclassifiedDollars: 0, unattributedDollars: 0,
});
async function page(initialFund = ledger(), fetchPage, options = {}) {
  const elements = new Map();
  const query = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  let fund = initialFund;
  let currentSnapshot = options.snapshot ?? snapshot;
  let snapshotFailed = false;
  let fundStatus = 200;
  let pendingFund;
  const events = {};
  const location = { search: options.search ?? '', hash: options.hash ?? '' };
  const context = createContext({
    URL, URLSearchParams, Intl,
    document: { querySelector: query, createElement: () => new Element(), body: { dataset: {} } },
    window: { location, addEventListener(name, callback) { events[name] = callback; }, scrollTo() {}, setInterval() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: { getItem: () => null },
    fetch: async (url) => {
      if (fetchPage) return fetchPage(url);
      if (url.endsWith('/snapshot')) {
        if (snapshotFailed) throw new Error('Offline');
        return { ok: true, json: async () => currentSnapshot };
      }
      if (pendingFund) return pendingFund;
      return { ok: fundStatus === 200, status: fundStatus, json: async () => fund };
    },
  });
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
    .replace("import './reef.js';", '')
    .replace('refresh();\nwindow.setInterval', 'globalThis.initialRefresh = refresh();\nwindow.setInterval');
  runInContext(source, context);
  await context.initialRefresh;
  return {
    fund: query('#fund'),
    navigation: query('#view-nav'),
    navigate(hash) { location.hash = hash; events.hashchange?.(); },
    visibleTrip: () => visibleText(query('#trip')),
    trip: query('#trip'),
    setSnapshot(value) { currentSnapshot = value; },
    refresh: () => runInContext('refresh()', context),
    refreshFund: () => runInContext('refreshFund(12)', context),
    setFund(value) { fund = value; },
    failSnapshot() { snapshotFailed = true; },
    failFund(status) { fundStatus = status; },
    deferFund(promise) { pendingFund = promise; },
  };
}

describe('Who covered what page', () => {
  it('renders the API nets with their correct direction and labels the simulation', async () => {
    const p = await page();
    expect(text(p.fund)).toMatch(/Mason.*is owed \$43/);
    expect(text(p.fund)).toMatch(/Alex.*owes \$7/);
    expect(text(p.fund)).toMatch(/Jordan.*owes \$36/);
    expect(text(p.fund)).toMatch(/simulat/i);
    expect(text(p.fund)).toMatch(/never moves money/i);
  });
  it('clears stale bank amounts when the snapshot cannot be refreshed', async () => {
    const p = await page();
    p.failSnapshot();
    await p.refresh();
    expect(text(p.fund)).toMatch(/tracking is unavailable/i);
    expect(text(p.fund)).not.toMatch(/\$|Mason|Alex|Jordan/);
    expect(text(p.fund)).toMatch(/simulat/i);
  });
  it('clears amounts on a 503 bank failure and keeps the simulation label', async () => {
    const p = await page();
    p.failFund(503);
    await p.refresh();
    expect(text(p.fund)).toMatch(/tracking is unavailable/i);
    expect(text(p.fund)).not.toContain('$');
    expect(text(p.fund)).toMatch(/simulat/i);
  });
  it('clears amounts when a 409 says the plan changed during the request', async () => {
    const p = await page();
    p.failFund(409);
    await p.refresh();
    expect(text(p.fund)).not.toContain('$');
    expect(text(p.fund)).toMatch(/plan changed/i);
  });
  it('does not leave amounts from the old revision on a mismatched fund response', async () => {
    const p = await page();
    p.setFund({ ...ledger(), revision: 13 });
    await p.refresh();
    expect(text(p.fund)).not.toContain('$');
    expect(text(p.fund)).toMatch(/plan changed/i);
  });
  it('hides the entire panel when tracking is disabled', async () => {
    const p = await page();
    p.setFund({ status: 'disabled', revision: 12 });
    await p.refresh();
    expect(p.fund.hidden).toBe(true);
    expect(text(p.fund).trim()).toBe('');
  });
  it('preserves the panel nodes when an unchanged ledger is polled again', async () => {
    const p = await page();
    const heading = p.fund.children[0];
    await p.refresh();
    expect(p.fund.children[0]).toBe(heading);
  });
  it('shows an empty ledger without suggesting anyone owes an unpaid contribution', async () => {
    const p = await page();
    const empty = ledger();
    empty.sharedSpentDollars = 0;
    empty.transfers = [];
    empty.members = empty.members.map(m => ({ ...m, coveredDollars: 0, fairShareDollars: 0, netDollars: 0, byCategory: [] }));
    p.setFund(empty);
    await p.refresh();
    expect(text(p.fund)).toMatch(/Nothing shared yet/i);
    expect(text(p.fund)).toMatch(/Nobody owes anything yet/i);
  });
  it('renders a not-ready reason without stale amounts', async () => {
    const p = await page();
    p.setFund({ status: 'not_ready', reason: 'Approve a plan first.', mode: 'mock', revision: 12 });
    await p.refresh();
    expect(text(p.fund)).toContain('Approve a plan first.');
    expect(text(p.fund)).not.toContain('$');
  });
  it('does not let an older response erase a newer error state', async () => {
    const p = await page();
    let finish;
    p.deferFund(new Promise(resolve => { finish = resolve; }));
    const inFlight = p.refreshFund();
    p.failSnapshot();
    await p.refresh();
    finish({ ok: true, json: async () => ledger() });
    await inFlight;
    expect(text(p.fund)).toMatch(/tracking is unavailable/i);
    expect(text(p.fund)).not.toContain('$');
  });
});


const descendants = (node) => node.children.flatMap(child => [child, ...descendants(child)]);
const calendarLinks = (node) => descendants(node).filter(child => child.href?.endsWith('/plan.ics'));

describe('Approved-plan calendar link', () => {
  it('offers a relative calendar download for an approved plan', async () => {
    const p = await page();
    const links = calendarLinks(p.trip);
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('/api/trips/chapel-hill-weekend/plan.ics');
    expect(links[0].textContent).toMatch(/Add this plan to your calendar.*\.ics/);
  });
  it.each(['gathering', 'researching', 'proposed', 'awaiting_acceptance'])(
    'has no calendar link while the trip is %s', async status => {
      const p = await page(undefined, undefined, { snapshot: { ...snapshot, status } });
      expect(calendarLinks(p.trip)).toHaveLength(0);
    });
  it('removes the download after approval is invalidated', async () => {
    const p = await page();
    expect(calendarLinks(p.trip)).toHaveLength(1);
    p.setSnapshot({ ...snapshot, status: 'proposed', revision: 13 });
    await p.refresh();
    expect(calendarLinks(p.trip)).toHaveLength(0);
  });
  it('encodes the trip from the page URL into a same-origin path', async () => {
    const p = await page(undefined, undefined, { search: '?trip=weekend%2Ffriends%3Fview' });
    expect(calendarLinks(p.trip)[0]?.href).toBe('/api/trips/weekend%2Ffriends%3Fview/plan.ics');
  });
});


const candidate = (overrides = {}) => ({
  candidateId: 'park', revision: 12, title: 'Park weekend', startAt: '2026-11-14T09:00:00-05:00', endAt: '2026-11-16T09:00:00-05:00',
  dataSource: 'fixture', itinerary: [], costs: [], contingencyCents: 3000, perPersonTotals: [],
  evidence: [], tradeoffs: [], feasibility: { feasible: true, unknownEssentials: [], violatedConstraints: [] }, ...overrides,
});

describe('Plan states and evidence honesty', () => {
  it.each([
    ['gathering', /Gathering trip details/i],
    ['researching', /Researching trip options/i],
    ['proposed', /Compare the options/i],
    ['awaiting_acceptance', /Waiting for everyone/i],
    ['approved', /Everyone.*in/i],
  ])('explains the %s state even with no candidates', async (status, expected) => {
    const p = await page(undefined, undefined, { snapshot: { ...snapshot, status } });
    expect(text(p.trip)).toMatch(expected);
    if (status !== 'gathering') expect(text(p.trip)).not.toMatch(/Your group is gathering/);
  });
  it('labels fixture prices as made-up demo data and live prices as web-search estimates', async () => {
    const p = await page(undefined, undefined, { snapshot: { ...snapshot, candidates: [candidate(), candidate({ candidateId: 'live', dataSource: 'live' })] } });
    expect(text(p.trip)).toMatch(/demo data.*prices made up/i);
    expect(text(p.trip)).toMatch(/estimates from web search/i);
  });
  it('shows an essential unknown as a maybe and never displays its missing price as zero', async () => {
    const c = candidate({
      costs: [{ costId: 'hotel', category: 'lodging', label: 'Hotel', lowCents: 0, highCents: 0, allocation: 'equal_shared', priceStatus: 'unknown', evidenceIds: [] }],
      feasibility: { feasible: false, unknownEssentials: ['Hotel'], violatedConstraints: [] },
    });
    const p = await page(undefined, undefined, { snapshot: { ...snapshot, candidates: [c] } });
    expect(text(p.trip)).toMatch(/price not found/i);
    expect(text(p.trip)).toMatch(/Maybe/i);
    expect(text(p.trip)).not.toContain('$0');
    expect(text(p.trip)).not.toContain('Within known limits');
  });
  it('shows source claims and uncertainty with community attribution', async () => {
    const c = candidate({ evidence: [{ evidenceId: 's1', url: 'https://example.com/trip', title: 'A traveler report', kind: 'community', retrievedAt: '2026-10-11T09:00:00Z', claim: 'One traveler found the trail crowded.', uncertainty: 'One account; conditions may differ.' }] });
    const p = await page(undefined, undefined, { snapshot: { ...snapshot, candidates: [c] } });
    expect(text(p.trip)).toContain('One traveler found the trail crowded.');
    expect(text(p.trip)).toContain('One account; conditions may differ.');
    expect(text(p.trip)).toMatch(/one person.s experience/i);
    const link = descendants(p.trip).find(node => node.href === 'https://example.com/trip');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.target).toBe('_blank');
  });
  it.each(['http://example.com/trip', 'javascript:alert(1)', 'invalid'])('keeps unsafe source URL %s as plain text', async url => {
    const c = candidate({ evidence: [{ evidenceId: 's1', url, title: '<img onerror=alert(1)>', kind: 'web', retrievedAt: '2026-10-11T09:00:00Z', claim: '<script>untrusted</script>' }] });
    const p = await page(undefined, undefined, { snapshot: { ...snapshot, candidates: [c] } });
    expect(descendants(p.trip).some(node => node.href === url)).toBe(false);
    expect(text(p.trip)).toContain(url);
    expect(text(p.trip)).toContain('<script>untrusted</script>');
  });
  it('marks the selected current-revision plan as approved without calling it booked', async () => {
    const c = candidate();
    const p = await page(undefined, undefined, { snapshot: { ...snapshot, candidates: [c], selectedCandidate: c } });
    expect(text(p.trip)).toContain('Approved plan');
    expect(text(p.trip)).toMatch(/not bookings|nothing is booked/i);
  });
});


describe('Live price presentation', () => {
  it('keeps a found live price labelled as an estimate instead of verified inventory', async () => {
    const c = candidate({ dataSource: 'live', costs: [{ costId: 'hotel', category: 'lodging', label: 'Hotel', lowCents: 9000, highCents: 11000, allocation: 'equal_shared', priceStatus: 'verified', evidenceIds: [] }] });
    const p = await page(undefined, undefined, { snapshot: { ...snapshot, candidates: [c] } });
    expect(text(p.trip)).toContain('$90.00 to $110.00');
    expect(text(p.trip)).toMatch(/Hotel.*estimate/);
    expect(text(p.trip)).not.toMatch(/\bverified\b/i);
  });
});

const visibleText = (node) => node.hidden ? '' : [node.textContent, ...node.children.map(visibleText)].join(' ');

describe('focused trip views', () => {
  it('keeps route and source details out of the overview, then navigates to their own views', async () => {
    const c = candidate();
    c.itinerary = [{ location: 'Trailhead', startAt: c.startAt, endAt: c.endAt, travelMinutesEstimate: 45 }];
    c.evidence = [{ title: 'Trail source', url: 'https://example.com/trail', kind: 'official', uncertainty: 'Hours may change' }];
    const p = await page(ledger(), undefined, { snapshot: { ...snapshot, candidates: [c] } });
    expect(p.visibleTrip()).not.toContain('Trailhead');
    expect(p.visibleTrip()).not.toContain('Trail source');
    p.navigate('#itinerary');
    expect(p.visibleTrip()).toContain('Trailhead');
    expect(p.visibleTrip()).not.toContain('Trail source');
    p.navigate('#sources');
    expect(p.visibleTrip()).toContain('Trail source');
    expect(p.visibleTrip()).toContain('Hours may change');
    expect(p.visibleTrip()).not.toContain('Trailhead');
  });
  it('opens a deep-linked view and falls back from an unknown view', async () => {
    const p = await page(ledger(), undefined, { hash: '#costs', snapshot: { ...snapshot, candidates: [candidate()] } });
    expect(p.visibleTrip()).toContain('Upper estimate per person');
    p.navigate('#not-a-view');
    expect(p.visibleTrip()).toContain('Your shared plan');
  });
});

it('a specific-option link shows that option and returning home restores the overview', async () => {
  const a = candidate({ candidateId: 'first', title: 'Forest weekend' });
  const b = candidate({ candidateId: 'second', title: 'Town weekend' });
  const state = { ...snapshot, candidates: [a, b], selectedCandidate: a };
  const p = await page(ledger(), undefined, { snapshot: state, hash: '#costs/second' });
  const cards = () => p.trip.children.find(n => n.className?.includes('candidate-grid')).children;
  expect(cards()[0].hidden).toBe(true);
  expect(cards()[1].hidden).toBe(false);
  p.navigate('#overview');
  expect(cards().every(c => !c.hidden)).toBe(true);
  expect(p.visibleTrip()).toContain('Approved plan');
  expect(state.selectedCandidate.candidateId).toBe('first');
});

it('keeps spending tied to the selected plan while another option is being viewed', async () => {
  const selected = candidate({ candidateId: 'accepted', title: 'Accepted park weekend' });
  const other = candidate({ candidateId: 'alternative', title: 'Alternative city weekend' });
  const p = await page(ledger(), undefined, { snapshot: { ...snapshot, candidates: [selected, other], selectedCandidate: selected }, hash: '#costs/alternative' });
  expect(p.visibleTrip()).toContain('Alternative city weekend');
  expect(text(p.fund)).toContain('Spending for the selected plan: Accepted park weekend');
  expect(text(p.fund)).not.toContain('Spending for the selected plan: Alternative city weekend');
});
