const tripId = new URLSearchParams(window.location.search).get('trip') || 'chapel-hill-weekend';
const status = document.querySelector('#status');
const root = document.querySelector('#trip');
let hasSnapshot = false;
let displayedRevision;
let lastSnapshot;
let snapshotFingerprint;
let fundFingerprint;
let fundRequestId = 0;
let fundDisabled = false;
let outdoorOnly = false;
const expandedDetails = new Map();
const PLAN_STATES = {
  gathering: { title: 'Gathering trip details', text: 'Keep sharing dates, preferences and private limits with the assistant in your iMessage DMs. Options appear once the details fit.', empty: 'No options yet. The assistant is gathering the details needed to plan.' },
  researching: { title: 'Researching trip options', text: 'The assistant is looking up places, prices and sources. New options will arrive in your DMs; saved options may change.', empty: 'Research is in progress. New options will appear here when they are saved.' },
  proposed: { title: 'Compare the options', text: 'Tell the assistant which option you prefer in your DM. Picking an option does not mean accepting its costs.', empty: 'No options are saved for this revision. Ask the assistant to try looking again.' },
  awaiting_acceptance: { title: 'Waiting for everyone’s “I’m in”', text: 'Each friend needs to accept the chosen plan in their own DM. Acceptance applies to this exact revision.', empty: 'The selected option is unavailable in this view. Ask the assistant for the current plan before accepting.' },
  approved: { title: 'Everyone’s in', text: 'Everyone accepted this revision. Estimates are not bookings or guaranteed availability; a material change needs fresh acceptance.', empty: 'The approved option is unavailable in this view. Ask the assistant for the current saved plan.' },
};

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
  heading.append(element('h2', '', 'Your shared plan'));
  heading.append(element('span', 'revision', `Revision ${snapshot.revision}`));
  root.append(heading);
  const planState = PLAN_STATES[snapshot.status] ?? { title: 'Saved plan', text: 'Ask the assistant in your DM for the latest details.', empty: 'No saved options are available in this view.' };
  const summary = element('section', 'plan-state');
  summary.append(element('h3', '', planState.title), element('p', '', planState.text));
  root.append(summary);
  if (snapshot.status === 'approved') {
    const calendar = element('a', 'calendar-link', 'Add this plan to your calendar (.ics)');
    calendar.href = `/api/trips/${encodeURIComponent(tripId)}/plan.ics`;
    root.append(calendar);
  }

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
  else root.append(element('div', 'empty', outdoorOnly && snapshot.candidates.length ? 'No current plans have tagged outdoor stops. Choose All plans to see the other options.' : planState.empty));
}

function renderCandidate(candidate, snapshot) {
  const card = element('article', 'candidate');
  card.append(element('h3', '', candidate.title));
  if (snapshot.selectedCandidate?.candidateId === candidate.candidateId && snapshot.selectedCandidate.revision === candidate.revision) {
    card.append(element('p', 'selected-plan', snapshot.status === 'approved' ? 'Approved plan' : 'Selected plan · awaiting everyone’s acceptance'));
  }
  const dataLabel = candidate.dataSource === 'fixture' ? 'Demo data · prices made up'
    : candidate.dataSource === 'live' ? 'Estimates from web search · availability not confirmed'
    : 'Planning estimates · availability not confirmed';
  card.append(element('p', '', `Plan ${candidate.candidateId} | revision ${candidate.revision} | ${dataLabel}`));
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
      const priceLabel = item.priceStatus === 'unknown' ? 'price not found' : 'estimate';
      row.append(element('span', '', `${item.label} (${item.costId}) | ${priceLabel}`));
      row.append(element('strong', '', item.priceStatus === 'unknown' ? 'Price not found' : `${money(item.lowCents)} to ${money(item.highCents)}`));
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
    row.append(element('strong', '', candidate.feasibility.unknownEssentials.length && total.highCents === 0 ? 'No priced costs yet' : money(total.highCents)));
    personCosts.append(row);
  }
  card.append(personCosts);

  const accepted = snapshot.acceptances.filter((item) => item.candidateId === candidate.candidateId && item.revision === candidate.revision);
  const approved = snapshot.participants.length > 0 && accepted.length === snapshot.participants.length;
  const feasible = candidate.feasibility.feasible && candidate.feasibility.unknownEssentials.length === 0;
  const feasibilityText = candidate.feasibility.unknownEssentials.length ? 'Maybe · essential prices missing'
    : feasible ? 'Fits stated limits · estimated costs' : 'Does not fit current constraints';
  card.append(element('span', `feasibility${feasible ? '' : ' blocked'}`, feasibilityText));
  card.append(element('p', '', `Acceptance: ${accepted.length} of ${snapshot.participants.length} for this exact revision${approved ? ' | all accepted' : ''}.`));
  if (candidate.feasibility.unknownEssentials.length) {
    card.append(element('p', '', `Unverified essentials: ${candidate.feasibility.unknownEssentials.join(', ')}`));
  }

  const sources = disclosure(`${candidate.candidateId}:${candidate.revision}:sources`, `Research sources (${candidate.evidence.length})`);
  for (const evidence of candidate.evidence) {
    const source = element('div', 'source-record');
    let safeUrl;
    try {
      const parsed = new URL(evidence.url);
      if (parsed.protocol === 'https:') safeUrl = parsed.href;
    } catch { /* Unsupported URLs remain plain text. */ }
    const link = element(safeUrl ? 'a' : 'span', 'source', evidence.title);
    if (safeUrl) {
      link.href = safeUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    const kind = evidence.kind === 'community' ? "One person's experience"
      : evidence.kind === 'official' ? 'Official source' : evidence.kind === 'estimate' ? 'Estimate' : 'Web source';
    source.append(link, element('p', 'source-kind', kind), element('p', 'source-url', evidence.url));
    if (evidence.claim) source.append(element('p', 'source-claim', evidence.claim));
    if (evidence.uncertainty) source.append(element('p', 'source-uncertainty', `Uncertainty: ${evidence.uncertainty}`));
    sources.append(source);
  }
  card.append(sources);
  return card;
}

async function refresh(retryChangedPlan = true) {
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
    const planChanged = await refreshFund(snapshot.revision);
    if (planChanged && retryChangedPlan) await refresh(false);
  } catch (error) {
    fundRequestId += 1; // An older bank response cannot restore numbers after a failed plan refresh.
    showFundNotice('Cost tracking is unavailable. Reconnecting; previous amounts are hidden.');
    status.className = 'status error';
    status.textContent = hasSnapshot ? 'Showing the last saved plan; reconnecting...' : `${error.message} Retrying...`;
  }
}

refresh();
window.setInterval(refresh, 5000);

const CATEGORY_NAMES = { accommodation: 'Lodging', fuel_parking_tolls: 'Gas, parking and tolls', food: 'Food', activities: 'Activities', taxes_fees: 'Taxes and fees', other: 'Other' };
const categoryName = (category) => CATEGORY_NAMES[category] ?? category.replaceAll('_', ' ');
const dollars = (amount) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);

function showFundNotice(message) {
  const fundRoot = document.querySelector('#fund');
  fundFingerprint = undefined;
  fundRoot.replaceChildren();
  fundRoot.hidden = fundDisabled;
  if (fundDisabled) return;
  fundRoot.append(element('h2', '', 'Who covered what'));
  fundRoot.append(element('p', 'fund-label', 'Simulated money only. The bot calculates; it never moves money.'));
  fundRoot.append(element('p', 'fund-notice', message));
}

async function refreshFund(revision) {
  const fundRoot = document.querySelector('#fund');
  const requestId = ++fundRequestId;
  try {
    const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/fund`, { cache: 'no-store' });
    if (requestId !== fundRequestId || displayedRevision !== revision) return;
    if (response.status === 409) {
      showFundNotice('The plan changed. Refreshing cost tracking for the latest revision.');
      return true;
    }
    if (!response.ok) throw new Error();
    const fund = await response.json();
    if (requestId !== fundRequestId || displayedRevision !== revision) return;
    if (fund.revision !== revision) {
      showFundNotice('The plan changed. Refreshing cost tracking for the latest revision.');
      return true;
    }
    const fingerprint = JSON.stringify(fund);
    if (fingerprint === fundFingerprint) return;
    fundFingerprint = fingerprint;
    fundDisabled = fund.status === 'disabled';
    fundRoot.hidden = fundDisabled;
    fundRoot.replaceChildren();
    if (fundDisabled) return;
    fundRoot.append(element('h2', '', 'Who covered what'));
    fundRoot.append(element('p', 'fund-label', fund.mode === 'nessie' ? 'Simulated money · Nessie sandbox accounts · no real money' : 'Simulated money · local demo · no real money'));
    if (fund.status === 'not_ready') { fundRoot.append(element('p', '', fund.reason)); return; }
    const shares = fund.members.map((person) => person.fairShareDollars);
    const lowShare = shares.length ? Math.min(...shares) : 0;
    const highShare = shares.length ? Math.max(...shares) : 0;
    const shareText = lowShare === highShare ? dollars(lowShare) : `${dollars(lowShare)}–${dollars(highShare)}`;
    fundRoot.append(element('p', 'fund-total', fund.sharedSpentDollars === 0
      ? `Nothing shared yet · the plan expects about ${dollars(fund.expectedEachDollars)} each`
      : `${dollars(fund.sharedSpentDollars)} of shared costs so far · ${shareText} per person`));
    fundRoot.append(element('p', '', 'Anyone can pay for anything. This page adds it up from each person\'s own transactions, so nobody has to split a bill on the spot.'));
    const biggest = Math.max(1, ...fund.members.map((m) => Math.max(m.coveredDollars, m.fairShareDollars)));
    for (const person of fund.members) {
      const block = element('div', 'fund-person');
      const head = element('div', 'fund-person-row');
      const net = person.netDollars === 0 ? 'even' : person.netDollars > 0 ? `is owed ${dollars(person.netDollars)}` : `owes ${dollars(-person.netDollars)}`;
      head.append(element('span', 'fund-name', person.name), element('strong', 'fund-net', net));
      const share = element('p', 'fund-share', `Covered ${dollars(person.coveredDollars)} · fair share ${dollars(person.fairShareDollars)}`);
      const meter = element('progress', 'fund-meter');
      meter.max = biggest; meter.value = Math.min(person.coveredDollars, biggest);
      meter.setAttribute('aria-label', `${person.name} has covered ${dollars(person.coveredDollars)} of shared costs`);
      block.append(head, share, meter);
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
    fundRoot.append(element('p', '', fund.transfers.length === 0 ? (fund.sharedSpentDollars === 0 ? 'Nobody owes anything yet.' : 'Everyone is even.') : fund.transfers.map((t) => `${t.from} would owe ${t.to} ${dollars(t.dollars)}`).join(' · ')));
    const notes = [];
    if (fund.unclassifiedDollars > 0) notes.push(`${dollars(fund.unclassifiedDollars)} had no category, so it is left out.`);
    if (fund.unattributedDollars > 0) notes.push(`${dollars(fund.unattributedDollars)} came from an account that is not on this trip.`);
    notes.push('Food stays personal. The bot only watches and calculates; it never moves money.');
    fundRoot.append(element('p', 'fund-label', notes.join(' ')));
  } catch {
    if (requestId !== fundRequestId || displayedRevision !== revision) return;
    showFundNotice('Cost tracking is unavailable. Retrying shortly; previous amounts are hidden.');
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
