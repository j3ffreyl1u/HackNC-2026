const tripId = new URLSearchParams(window.location.search).get('trip') || 'chapel-hill-weekend';
const status = document.querySelector('#status');
const root = document.querySelector('#trip');
let hasSnapshot = false;

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
  root.replaceChildren();
  const heading = element('div', 'trip-heading');
  heading.append(element('h2', '', "The group's plan"));
  heading.append(element('span', 'revision', `Revision ${snapshot.revision} | ${snapshot.status.replaceAll('_', ' ')}`));
  root.append(heading);

  const people = element('div', 'people');
  for (const person of snapshot.participants) people.append(element('span', 'person', person.displayName));
  root.append(people);

  const candidates = element('div', 'candidate-grid');
  for (const candidate of snapshot.candidates) candidates.append(renderCandidate(candidate, snapshot));
  if (candidates.childElementCount) root.append(candidates);
  else root.append(element('div', 'empty', 'Your group is gathering dates, budgets, and ideas. Plan options will appear here when they are ready.'));
}

function renderCandidate(candidate, snapshot) {
  const card = element('article', 'candidate');
  card.append(element('h3', '', candidate.title));
  card.append(element('p', '', `Plan ${candidate.candidateId} | revision ${candidate.revision} | ${candidate.dataSource === 'fixture' ? 'Synthetic fixture' : 'Live/manual estimates'}`));
  card.append(element('div', 'date', dateRange(candidate.startAt, candidate.endAt)));
  for (const tradeoff of candidate.tradeoffs) card.append(element('p', '', tradeoff));

  if (candidate.itinerary.length) {
    const itinerary = element('section', 'costs');
    itinerary.append(element('h4', '', 'Itinerary and map links'));
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
    const costs = element('section', 'costs');
    costs.append(element('h4', '', 'Cost breakdown | range'));
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

  const sources = element('section', 'sources');
  sources.append(element('h4', '', 'Research sources'));
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
    render(snapshot);
    hasSnapshot = true;
    status.className = 'status';
    status.textContent = `Updated just now | ${snapshot.fundingStatus === 'disabled' ? 'No funding enabled' : `Funding ${snapshot.fundingStatus}`}`;
  } catch (error) {
    status.className = 'status error';
    status.textContent = hasSnapshot ? 'Showing the last saved plan; reconnecting...' : `${error.message} Retrying...`;
  }
}

refresh();
window.setInterval(refresh, 5000);
