const tripId = new URLSearchParams(window.location.search).get('trip') || 'chapel-hill-weekend';
const status = document.querySelector('#status');
const root = document.querySelector('#trip');
let hasSnapshot = false;
let displayedRevision;
let lastSnapshot;
let snapshotFingerprint;
let outdoorOnly = false;
const expandedDetails = new Map();

function disclosure(key, title, initiallyOpen = false) {
  const details = element('details', 'costs plan-disclosure');
  details.open = expandedDetails.get(key) ?? initiallyOpen;
  details.append(element('summary', '', title));
  details.addEventListener('toggle', () => expandedDetails.set(key, details.open));
  return details;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function money(cents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function dateRange(startAt, endAt) {
  const format = (value) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value));
  return `${format(startAt)} to ${format(endAt)}`;
}

function render(snapshot) {
  lastSnapshot = snapshot;
  displayedRevision = snapshot.revision;
  root.replaceChildren();
  const heading = element('div', 'trip-heading');
  heading.append(element('h2', '', "The group's plan"));
  heading.append(element('span', 'revision', `Revision ${snapshot.revision} | ${snapshot.status.replaceAll('_', ' ')}`));
  root.append(heading);

  const people = element('div', 'people');
  for (const person of snapshot.participants) people.append(element('span', 'person', person.displayName));
  root.append(people);
  if (snapshot.nature?.comparison) root.append(element('p', 'nature-comparison', snapshot.nature.comparison));

  const candidates = element('div', 'candidate-grid');
  for (const candidate of snapshot.candidates) {
    const hasOutdoor = snapshot.nature?.summaries.some(s => s.candidateId === candidate.candidateId && s.outdoorStops.length);
    if (!outdoorOnly || hasOutdoor) candidates.append(renderCandidate(candidate, snapshot));
  }
  if (candidates.childElementCount) root.append(candidates);
  else root.append(element('div', 'empty', outdoorOnly && snapshot.candidates.length ? 'No current plans have tagged outdoor stops. Choose All plans to see the other options.' : 'Your group is gathering dates, budgets, and ideas. Plan options will appear here when they are ready.'));
}

function renderCandidate(candidate, snapshot) {
  const card = element('article', 'candidate');
  card.append(element('h3', '', candidate.title));
  card.append(element('p', '', `Plan ${candidate.candidateId} | revision ${candidate.revision} | ${candidate.dataSource === 'fixture' ? 'Synthetic fixture' : 'Live/manual estimates'}`));
  card.append(element('div', 'date', dateRange(candidate.startAt, candidate.endAt)));
  const nature = snapshot.nature?.summaries.find(item => item.candidateId === candidate.candidateId);
  if (nature) {
    const section = element('section', 'nature-summary');
    section.append(element('h4', '', 'A little time outdoors'));
    for (const stop of nature.outdoorStops) section.append(element('p', '', `${stop.label} · ${stop.location}`));
    if (!nature.outdoorStops.length) section.append(element('p', '', 'No outdoor stops identified in the plan tags.'));
    section.append(element('p', '', `${nature.drivingMinutes} minutes of recorded driving${nature.unknownLegs ? `; ${nature.unknownLegs} legs are unestimated` : ''}. Drive home is not counted.${candidate.dataSource === 'fixture' ? ' Synthetic demo data.' : ''}`));
    card.append(section);
  }
  for (const tradeoff of candidate.tradeoffs) card.append(element('p', '', tradeoff));

  if (candidate.itinerary.length) {
    const itinerary = disclosure(`${candidate.candidateId}:${candidate.revision}:itinerary`, 'Itinerary and map links', true);
    for (const item of candidate.itinerary) {
      const row = element('div', 'cost-row');
      row.append(element('span', '', `${item.location} | ${dateRange(item.startAt, item.endAt)}`));
      const map = document.createElement('a');
      map.className = 'source';
      map.textContent = 'Map';
      map.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location)}`;
      map.target = '_blank';
      map.rel = 'noopener noreferrer';
      row.append(map);
      itinerary.append(row);
      if (item.notes) itinerary.append(element('p', '', item.notes));
      if (item.travelMinutesEstimate !== undefined) itinerary.append(element('p', '', `Estimated travel: ${item.travelMinutesEstimate} minutes`));
    }
    card.append(itinerary);
  }

  if (candidate.costs.length) {
    const costs = disclosure(`${candidate.candidateId}:${candidate.revision}:costs`, 'Explore the cost breakdown');
    for (const item of candidate.costs) {
      const row = element('div', 'cost-row');
      row.append(element('span', '', `${item.label} (${item.costId}) | ${item.priceStatus}`));
      row.append(element('strong', '', item.priceStatus === 'unknown' ? 'Price not confirmed' : `${money(item.lowCents)} to ${money(item.highCents)}`));
      costs.append(row);
    }
    card.append(costs);
  }

  const personCosts = element('section', 'costs');
  personCosts.append(element('h4', '', candidate.feasibility.unknownEssentials.length ? 'Known portion per person | essential prices missing' : 'Upper estimate per person'));
  for (const total of candidate.perPersonTotals) {
    const name = snapshot.participants.find((person) => person.memberId === total.memberId)?.displayName ?? 'Participant';
    const row = element('div', 'cost-row');
    row.append(element('span', '', name));
    row.append(element('strong', '', money(total.highCents)));
    personCosts.append(row);
  }
  card.append(personCosts);

  const accepted = snapshot.acceptances.filter((item) => item.candidateId === candidate.candidateId && item.revision === candidate.revision);
  const approved = snapshot.participants.length > 0 && accepted.length === snapshot.participants.length;
  const feasible = candidate.feasibility.feasible && candidate.feasibility.unknownEssentials.length === 0;
  card.append(element('span', `feasibility${feasible ? '' : ' blocked'}`, feasible ? 'Within known limits' : 'Needs review'));
  card.append(element('p', '', `Acceptance: ${accepted.length} of ${snapshot.participants.length} for this exact revision${approved ? ' | all accepted' : ''}.`));
  if (candidate.feasibility.unknownEssentials.length) {
    card.append(element('p', '', `Unverified essentials: ${candidate.feasibility.unknownEssentials.join(', ')}`));
  }

  const sources = disclosure(`${candidate.candidateId}:${candidate.revision}:sources`, `Research sources (${candidate.evidence.length})`);
  for (const evidence of candidate.evidence) {
    const link = document.createElement('a');
    link.className = 'source';
    link.textContent = `${evidence.title} | ${evidence.kind}${evidence.uncertainty ? ' | uncertain' : ''}`;
    try {
      const parsed = new URL(evidence.url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        link.href = parsed.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    } catch { /* Keep unsupported source URLs visible as plain text. */ }
    sources.append(link);
  }
  card.append(sources);
  return card;
}

async function refresh() {
  try {
    const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/snapshot`, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 404 ? 'Trip not found.' : 'Could not refresh the plan.');
    const snapshot = await response.json();
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint !== snapshotFingerprint) {
      render(snapshot);
      snapshotFingerprint = fingerprint;
    }
    hasSnapshot = true;
    status.className = 'status';
    status.textContent = 'Latest saved plan · refreshed just now';
    await refreshFund(snapshot.revision);
  } catch (error) {
    status.className = 'status error';
    status.textContent = hasSnapshot ? 'Showing the last saved plan; reconnecting...' : `${error.message} Retrying...`;
  }
}

refresh();
window.setInterval(refresh, 5000);

const CATEGORY_NAMES = { accommodation: 'Lodging', fuel_parking_tolls: 'Gas, parking and tolls', food: 'Food', activities: 'Activities', taxes_fees: 'Taxes and fees', other: 'Other' };
const categoryName = (category) => CATEGORY_NAMES[category] ?? category.replaceAll('_', ' ');
const dollars = (amount) => money(amount * 100);

async function refreshFund(revision) {
  const fundRoot = document.querySelector('#fund');
  try {
    const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/fund`, { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const fund = await response.json();
    if (displayedRevision !== revision || fund.revision !== revision) return;
    fundRoot.replaceChildren();
    if (fund.status === 'disabled') return;
    fundRoot.append(element('h2', '', 'Who covered what'));
    fundRoot.append(element('p', 'fund-label', fund.mode === 'nessie' ? 'Nessie sandbox · each friend\'s own simulated account, no real money' : 'Local simulation · no real money'));
    if (fund.status === 'not_ready') { fundRoot.append(element('p', '', fund.reason)); return; }
    const each = fund.members.length > 0 ? Math.round(fund.sharedSpentDollars / fund.members.length) : 0;
    fundRoot.append(element('p', 'fund-total', fund.sharedSpentDollars === 0
      ? `Nothing shared yet · the plan expects about ${dollars(fund.expectedEachDollars)} each`
      : `${dollars(fund.sharedSpentDollars)} of shared costs so far · about ${dollars(each)} each`));
    fundRoot.append(element('p', '', 'Anyone can pay for anything. This page adds it up from each person\'s own transactions, so nobody has to split a bill on the spot.'));
    const biggest = Math.max(1, ...fund.members.map((m) => Math.max(m.coveredDollars, m.fairShareDollars)));
    for (const person of fund.members) {
      const block = element('div', 'fund-person');
      const head = element('div', 'cost-row');
      const net = person.netDollars === 0 ? 'even' : person.netDollars > 0 ? `is owed ${dollars(person.netDollars)}` : `owes ${dollars(-person.netDollars)}`;
      head.append(element('span', '', person.name), element('strong', '', `covered ${dollars(person.coveredDollars)} · ${net}`));
      const meter = element('progress', 'fund-meter');
      meter.max = biggest; meter.value = Math.min(person.coveredDollars, biggest);
      meter.setAttribute('aria-label', `${person.name} has covered ${dollars(person.coveredDollars)} of shared costs`);
      block.append(head, meter);
      if (person.byCategory.length > 0) block.append(element('p', 'fund-chips', person.byCategory.map((c) => `${categoryName(c.category)} ${dollars(c.dollars)}`).join(' · ')));
      fundRoot.append(block);
    }
    if (fund.spending.byCategory.length > 0) {
      fundRoot.append(element('h3', '', 'Against the plan'));
      for (const row of fund.spending.byCategory) {
        const line = element('div', 'cost-row');
        line.append(element('span', '', categoryName(row.category)), element('strong', '', `${dollars(row.spentDollars)} of ${dollars(row.plannedDollars)} planned · ${row.state}`));
        fundRoot.append(line);
      }
    }
    fundRoot.append(element('h3', '', 'If the trip ended now'));
    fundRoot.append(element('p', '', fund.transfers.length === 0 ? (fund.sharedSpentDollars === 0 ? 'Nobody owes anything yet.' : 'Everyone is even.') : fund.transfers.map((t) => `${t.from} sends ${t.to} ${dollars(t.dollars)}`).join(' · ')));
    const notes = [];
    if (fund.unclassifiedDollars > 0) notes.push(`${dollars(fund.unclassifiedDollars)} had no category, so it is left out.`);
    if (fund.unattributedDollars > 0) notes.push(`${dollars(fund.unattributedDollars)} came from an account that is not on this trip.`);
    notes.push('Food stays personal. The bot only watches and calculates; it never moves money.');
    fundRoot.append(element('p', 'fund-label', notes.join(' ')));
  } catch {
    fundRoot.replaceChildren(element('p', '', 'Cost tracking is unavailable. Retry shortly; no simulated fallback is shown.'));
  }
}

function setupInteractions() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motionButton = document.querySelector('#motion-toggle');
  let motionPreference = true;
  try { motionPreference = localStorage.getItem('weekend-motion') !== 'off'; } catch { /* Storage is optional. */ }
  const syncMotion = () => {
    const enabled = motionPreference && !reduced.matches;
    document.body.dataset.motion = enabled ? 'on' : 'off';
    motionButton.setAttribute('aria-pressed', String(enabled));
    motionButton.textContent = reduced.matches ? 'Reduced motion enabled' : enabled ? 'Reef motion: on' : 'Reef motion: off';
    motionButton.disabled = reduced.matches;

  };
  motionButton.addEventListener('click', () => {
    motionPreference = !motionPreference;
    try { localStorage.setItem('weekend-motion', motionPreference ? 'on' : 'off'); } catch { /* Storage is optional. */ }
    syncMotion();
  });
  reduced.addEventListener('change', syncMotion);
  syncMotion();
  const sceneButton = document.querySelector('#scene-toggle');
  const hero = document.querySelector('.hero');
  const heroCopy = document.querySelector('.hero-copy');
  sceneButton.addEventListener('click', () => {
    const scenic = hero.classList.toggle('scenery-mode');
    heroCopy.inert = scenic;
    heroCopy.setAttribute('aria-hidden', String(scenic));
    sceneButton.setAttribute('aria-pressed', String(scenic));
    sceneButton.textContent = scenic ? 'Show the introduction' : 'Enjoy the scenery';
  });
  for (const [id, value] of [['filter-all', false], ['filter-outdoors', true]]) {
    document.querySelector(`#${id}`).addEventListener('click', () => {
      outdoorOnly = value;
      document.querySelector('#filter-all').setAttribute('aria-pressed', String(!value));
      document.querySelector('#filter-outdoors').setAttribute('aria-pressed', String(value));
      if (lastSnapshot) render(lastSnapshot);
    });
  }
}
setupInteractions();
import './reef.js';
