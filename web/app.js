const params = new URLSearchParams(window.location.search);
const tripId = params.get('trip') || 'chapel-hill-weekend';
const dashboardMode = params.get('view') === 'dashboard';
document.body.dataset.view = dashboardMode ? 'dashboard' : 'reef';
document.querySelector('#dashboard').hidden = !dashboardMode;
const dashboardUrl = new URL('/', window.location.origin);
dashboardUrl.searchParams.set('view', 'dashboard');
dashboardUrl.searchParams.set('trip', tripId);
for (const link of document.querySelectorAll('[data-dashboard-link], .explorer-bar a[href="#trip"]')) link.href = dashboardUrl.href;
for (const link of document.querySelectorAll('[data-home-link], .brand')) link.href = `/?trip=${encodeURIComponent(tripId)}`;
if (dashboardMode) document.title = 'Your trip | Weekend, together';
const status = document.querySelector('#status');
const root = document.querySelector('#trip');
let hasSnapshot = false;
let displayedRevision;
let lastSnapshot;
let snapshotFingerprint;
let outdoorOnly = false;
let previewCandidateId;
let activeDay = 'all';
let latestFund;
let fundFingerprint;
let refreshing = false;
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
  if (dashboardMode) {
    renderDashboard(snapshot);
    if (latestFund?.revision === snapshot.revision) renderDashboardFund(latestFund);
    else {
      latestFund = undefined;
      fundFingerprint = undefined;
      renderDashboardFund({ status: 'loading', revision: snapshot.revision });
    }
    return;
  }
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

  const accepted = acceptedMembers(snapshot, candidate);
  const approved = snapshot.participants.length > 0 && accepted.size === snapshot.participants.length;
  const feasible = candidate.feasibility.feasible && candidate.feasibility.unknownEssentials.length === 0;
  card.append(element('span', `feasibility${feasible ? '' : ' blocked'}`, feasible ? 'Within known limits' : 'Needs review'));
  card.append(element('p', '', `Acceptance: ${accepted.size} of ${snapshot.participants.length} for this exact revision${approved ? ' | all accepted' : ''}.`));
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
  if (refreshing || document.hidden) return;
  refreshing = true;
  try {
    const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/snapshot`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
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
    updateSyncStatus('Up to date', false);
    await refreshFund(snapshot.revision);
  } catch (error) {
    status.className = 'status error';
    status.textContent = hasSnapshot ? 'Showing the last saved plan; reconnecting...' : `${error.message} Retrying...`;
    updateSyncStatus(hasSnapshot ? 'Offline · showing saved trip' : 'Unable to load trip · retrying', true);
    if (dashboardMode && !hasSnapshot) document.querySelector('#dashboard-content').replaceChildren(element('div', 'dashboard-empty', `${error.message} Check the trip link and that the local app is running. We’ll retry automatically.`));
  } finally {
    refreshing = false;
  }
}

refresh();
window.setInterval(refresh, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

async function refreshFund(revision) {
  const fundRoot = document.querySelector('#fund');
  try {
    const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/fund`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    const fund = await response.json();
    if (displayedRevision !== revision || fund.revision !== revision) return;
    if (dashboardMode) {
      const fingerprint = JSON.stringify(fund);
      latestFund = fund;
      if (fingerprint !== fundFingerprint) renderDashboardFund(fund);
      fundFingerprint = fingerprint;
      return;
    }
    fundRoot.replaceChildren();
    if (fund.status === 'disabled') return;
    fundRoot.append(element('h2', '', 'Our shared trip fund'));
    fundRoot.append(element('p', 'fund-label', fund.mode === 'nessie' ? 'Nessie sandbox · simulated transactions, no real money' : 'Local simulation · no real money'));
    if (fund.status === 'not_ready') { fundRoot.append(element('p', '', fund.reason)); return; }
    fundRoot.append(element('p', 'fund-total', `${money(fund.collectedDollars * 100)} of ${money(fund.neededDollars * 100)} collected`));
    const progress = element('progress', 'fund-meter');
    progress.max = Math.max(1, fund.neededDollars); progress.value = Math.min(fund.collectedDollars, progress.max);
    progress.setAttribute('aria-label', 'Shared contributions collected');
    fundRoot.append(progress);
    fundRoot.append(element('p', '', `${fund.status.replaceAll('_', ' ')} · ${fund.missingCount} contributions still incomplete · revision ${fund.revision}`));
    fundRoot.append(element('p', '', `Remaining after completed purchases: ${money(fund.remainingDollars * 100)}. Calculated from transactions, not the sandbox account balance.`));
    for (const row of fund.spending.byCategory) {
      const line = element('div', 'cost-row');
      line.append(element('span', '', row.category.replaceAll('_', ' ')), element('strong', '', `${money(row.spentDollars * 100)} / ${money(row.plannedDollars * 100)} · ${row.state}`));
      fundRoot.append(line);
    }
    fundRoot.append(element('p', '', `Unclassified spending: ${money(fund.spending.unclassifiedDollars * 100)}. Earlier-revision deposits: ${money(fund.staleDollars * 100)}. Unattributed deposits: ${money(fund.unattributedDollars * 100)}. These deposits do not count toward current contributions.`));
  } catch {
    if (dashboardMode) {
      if (displayedRevision !== revision) return;
      latestFund = { status: 'unknown', revision };
      fundFingerprint = undefined;
      renderDashboardFund(latestFund);
      return;
    }
    fundRoot.replaceChildren(element('p', '', 'Fund unavailable. Retry shortly; no simulated fallback is shown.'));
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
    motionButton.textContent = reduced.matches ? 'Reduced motion enabled' : enabled ? 'Animation: on' : 'Animation: off';
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
    sceneButton.textContent = scenic ? 'Show trip introduction' : 'Focus on the reef';
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
if (!dashboardMode) import('./reef.js');

function acceptedMembers(snapshot, candidate) {
  const roster = new Set(snapshot.participants.map(person => person.memberId));
  return new Set(snapshot.acceptances.filter(item => item.candidateId === candidate.candidateId && item.revision === candidate.revision && roster.has(item.actorId)).map(item => item.actorId));
}

function icon(name) {
  const paths = {
    calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z'],
    pin: ['M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z', 'M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
    check: ['m5 12 4 4L19 6'],
    people: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'M20 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
    leaf: ['M11 20a10 10 0 0 0 10-10V3c-5 4-9 2-13 4a7 7 0 0 0 3 13Z', 'M2 21c2-5 5-5 10-9'],
    chat: ['M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 3V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z', 'M7 10h10', 'M7 14h6'],
    arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
    wallet: ['M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v11H5a3 3 0 0 1-3-3V6', 'M20 12h-4v4h4'],
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  for (const d of paths[name] || paths.pin) {
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}

function panel(title, id, className = '') {
  const section = element('section', `dashboard-panel ${className}`);
  if (id) section.id = id;
  section.append(element('h2', '', title));
  return section;
}

function formatDate(value, options = {}) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC', ...options }).format(date) : 'Date not confirmed';
}

function updateSyncStatus(text, offline) {
  const node = document.querySelector('#dashboard-sync');
  if (node) { node.textContent = text; node.classList.toggle('offline', offline); }
}

function viewedCandidate(snapshot) {
  return snapshot.candidates.find(candidate => candidate.candidateId === previewCandidateId)
    ?? snapshot.selectedCandidate
    ?? snapshot.candidates.find(candidate => candidate.feasibility.feasible && !candidate.feasibility.unknownEssentials.length)
    ?? snapshot.candidates[0];
}

function renderDashboard(snapshot) {
  const host = document.querySelector('#dashboard-content');
  const focused = document.activeElement?.dataset.focusKey;
  const candidate = viewedCandidate(snapshot);
  const selected = candidate && snapshot.selectedCandidate?.candidateId === candidate.candidateId;
  const accepted = candidate ? acceptedMembers(snapshot, candidate) : new Set();
  const current = candidate?.revision === snapshot.revision;
  const complete = Boolean(selected && current && snapshot.status === 'approved' && snapshot.participants.length >= 2 && accepted.size === snapshot.participants.length && candidate.feasibility.feasible && !candidate.feasibility.unknownEssentials.length);
  const nature = snapshot.nature?.summaries.find(summary => summary.candidateId === candidate?.candidateId);
  host.replaceChildren();

  const welcome = element('div', 'dashboard-welcome');
  const intro = element('div');
  intro.append(element('h1', '', candidate ? candidate.title : 'Your next adventure, together.'), element('p', '', candidate ? `${dateRange(candidate.startAt, candidate.endAt)} · ${snapshot.participants.length} people · Revision ${snapshot.revision}` : 'Keep planning in your chat. Your shared itinerary will take shape here.'));
  const sync = element('span', 'dashboard-sync', 'Updating…'); sync.id = 'dashboard-sync'; sync.setAttribute('role', 'status');
  welcome.append(intro, sync); host.append(welcome);

  const cover = element('section', 'dashboard-cover');
  const coverCopy = element('div', 'dashboard-cover-copy');
  coverCopy.append(element('span', `dashboard-badge ${complete ? 'ready' : ''}`, candidate ? complete ? 'Everyone accepted this plan' : selected ? 'Your group’s selected plan' : 'Option preview · not selected' : 'Planning in progress'));
  if (candidate?.dataSource === 'fixture') coverCopy.append(element('span', 'dashboard-badge dashboard-demo-label', 'Synthetic demo data'));
  coverCopy.append(element('h2', '', complete ? 'A weekend worth getting together for.' : candidate ? 'Good plans start with everyone on board.' : 'A little less organizing. A lot more exploring.'));
  coverCopy.append(element('p', '', complete ? 'Your group has agreed on this version. Find every stop, shared cost, and source below.' : candidate ? 'Explore the itinerary below. Make changes and accept the exact plan version in your chat.' : 'Share your dates, ideas, and limits with the assistant in your conversation. This page follows along.'));
  const jump = element('a', 'dashboard-primary', candidate ? 'Explore the itinerary' : 'See the group'); jump.href = candidate ? '#dashboard-itinerary' : '#dashboard-group'; jump.append(icon('arrow')); coverCopy.append(jump); cover.append(coverCopy);
  cover.append(element('span', 'dashboard-image-note', 'Nature-inspired scenery · not a photo of your destination'));
  host.append(cover);

  const facts = element('dl', 'dashboard-facts');
  const totals = candidate?.perPersonTotals || [];
  const known = candidate && candidate.feasibility.unknownEssentials.length > 0;
  const price = totals.length ? `${money(Math.min(...totals.map(total => total.lowCents)))}–${money(Math.max(...totals.map(total => total.highCents)))}` : 'Not estimated';
  for (const [symbol, label, value, detail] of [
    ['calendar', 'Dates', candidate ? dateRange(candidate.startAt, candidate.endAt) : 'Still deciding', 'Saved trip window'],
    ['wallet', known ? 'Known cost per person' : 'Estimate per person', price, known ? 'Essential prices still missing' : 'Includes the plan’s contingency'],
    ['leaf', 'Time outdoors', nature ? `${nature.outdoorStops.length} ${nature.outdoorStops.length === 1 ? 'stop' : 'stops'}` : 'Not identified', nature ? `${nature.drivingMinutes} min recorded driving${nature.unknownLegs ? ' · some legs unknown' : ''}` : 'Based on the plan’s tags'],
    ['people', 'Group acceptance', candidate ? `${accepted.size} of ${snapshot.participants.length}` : 'No plan to accept yet', candidate ? `For this option, revision ${candidate.revision}` : 'Acceptance happens in chat'],
  ]) {
    const fact = element('div', 'dashboard-fact'); const labelNode = element('dt', '', label); labelNode.prepend(icon(symbol));
    fact.append(labelNode, element('dd', '', value), element('p', '', detail)); facts.append(fact);
  }
  host.append(facts);

  if (snapshot.candidates.length > 1) {
    const options = element('div', 'dashboard-options'); options.append(element('span', '', 'Compare options'));
    for (const option of snapshot.candidates) {
      const button = element('button', '', option.title);
      button.type = 'button'; button.setAttribute('aria-pressed', String(option.candidateId === candidate?.candidateId));
      button.dataset.focusKey = `option:${option.candidateId}`;
      button.addEventListener('click', () => { previewCandidateId = option.candidateId; activeDay = 'all'; render(snapshot); });
      if (snapshot.selectedCandidate?.candidateId === option.candidateId) button.append(element('small', '', 'Selected in chat'));
      options.append(button);
    }
    options.append(element('p', '', 'Viewing an option here doesn’t select or accept it.')); host.append(options);
  }

  const layout = element('div', 'dashboard-layout');
  const main = element('div', 'dashboard-main-column');
  const side = element('aside', 'dashboard-side-column');
  if (candidate) {
    main.append(renderItinerary(candidate, nature));
    main.append(renderCostChart(candidate));
    const notes = panel('Before you go', 'dashboard-notes');
    notes.append(element('p', 'dashboard-subtitle', 'A quick check before you rely on this plan.'));
    const checks = element('ul', 'dashboard-checklist');
    const addCheck = (title, detail, blocking = false) => {
      const item = element('li', blocking ? 'is-blocking' : '');
      const copy = element('div', 'dashboard-check-copy');
      copy.append(element('strong', '', title), element('span', '', detail));
      item.append(copy);
      checks.append(item);
    };
    if (!current) addCheck('Get an updated option', 'This plan is from an older revision. Ask for a fresh option in chat before accepting it.', true);
    if (!candidate.itineraryConfirmed) addCheck('Confirm the itinerary', 'Check local timing, opening hours, and travel times with the group.');
    if (candidate.feasibility.unknownEssentials.length) addCheck('Confirm essential prices', `${candidate.feasibility.unknownEssentials.join(', ')}. Affordability is not confirmed yet.`, true);
    if (checks.childElementCount) notes.append(checks);
    if (candidate.tradeoffs.length) {
      const tradeoffs = element('div', 'dashboard-tradeoffs');
      tradeoffs.append(element('h3', '', 'Trade-offs'));
      for (const tradeoff of candidate.tradeoffs) tradeoffs.append(element('p', '', tradeoff));
      notes.append(tradeoffs);
    }
    if (candidate.dataSource === 'fixture') notes.append(element('p', 'dashboard-context-note', 'Synthetic demo: dates, prices, sources, and driving estimates are examples.'));
    notes.append(element('p', 'dashboard-context-note', 'Plans and estimates aren’t bookings or guaranteed availability.'));
    const sources = disclosure(`${candidate.candidateId}:${candidate.revision}:dashboard-sources`, `Check the sources (${candidate.evidence.length})`);
    for (const source of candidate.evidence) {
      const link = element('a', 'source', `${source.title}${source.uncertainty ? ' · uncertain' : ''}`);
      try { const url = new URL(source.url); if (['http:', 'https:'].includes(url.protocol)) { link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; } } catch { /* Invalid sources remain text. */ }
      sources.append(link);
    }
    if (!candidate.evidence.length) sources.append(element('p', '', 'No source links have been saved for this option.'));
    notes.append(sources); main.append(notes);
  } else {
    const empty = panel('Your itinerary will live here', 'dashboard-itinerary');
    empty.append(icon('calendar'), element('p', '', 'Once the group has shared its dates, destination, transport, and individual limits, the assistant can suggest plans. Every stop and cost will appear here.'), element('p', '', 'Ask “what’s still missing?” in your chat to see the next step.')); main.append(empty);
  }
  side.append(renderGroup(snapshot, candidate, accepted));
  const next = panel('What happens next?', 'dashboard-next');
  let nextText = !candidate ? 'Keep sharing your trip details in chat. Ask for options when the group is ready.'
    : !current ? 'Ask for fresh options in chat. Earlier acceptances don’t carry over to this revision.'
    : !candidate.feasibility.feasible || candidate.feasibility.unknownEssentials.length ? 'Review the constraints or confirm the missing prices in chat before accepting this plan.'
    : !selected ? 'Tell the assistant which option your group wants to select. Then everyone can accept the same revision.'
    : !complete ? 'Anyone still reviewing should accept this exact plan version in chat. Changing the plan means accepting again.'
    : 'Your plan is accepted. Check each venue’s latest details and ask the assistant about alternatives or the shared fund in chat.';
  next.append(icon('chat'), element('p', '', nextText)); side.append(next);
  if (nature) {
    const outdoor = panel('A little more outside', 'dashboard-outdoors', 'dashboard-outdoors');
    outdoor.append(icon('leaf'));
    for (const stop of nature.outdoorStops) outdoor.append(element('p', '', stop.label), element('small', '', stop.location));
    if (!nature.outdoorStops.length) outdoor.append(element('p', '', 'No tagged outdoor stops in this option. Ask the assistant for an outdoor alternative.'));
    if (snapshot.nature?.comparison) outdoor.append(element('p', 'dashboard-driving', snapshot.nature.comparison));
    outdoor.append(element('small', '', 'Driving is based on recorded legs. The drive home isn’t counted.')); side.append(outdoor);
  }
  layout.append(main, side); host.append(layout);
  // Preserve keyboard focus if a poll replaces a changed snapshot.
  if (focused) [...host.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focused)?.focus({ preventScroll: true });
}

function renderGroup(snapshot, candidate, accepted) {
  const section = panel('Everyone on the same page', 'dashboard-group');
  section.append(element('p', 'dashboard-subtitle', candidate ? `Acceptances for revision ${candidate.revision}` : 'Your enrolled travel group'));
  const progress = element('progress', 'dashboard-acceptance');
  progress.max = Math.max(1, snapshot.participants.length); progress.value = accepted.size;
  progress.setAttribute('aria-label', `${accepted.size} of ${snapshot.participants.length} participants accepted this option`); section.append(progress);
  for (const person of snapshot.participants) {
    const row = element('div', 'dashboard-member');
    const avatar = element('span', 'dashboard-avatar', person.displayName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('')); avatar.setAttribute('aria-hidden', 'true');
    const copy = element('div'); copy.append(element('strong', '', person.displayName), element('small', '', accepted.has(person.memberId) ? 'Accepted this version' : candidate ? 'Still reviewing' : 'Planning together'));
    row.append(avatar, copy); if (accepted.has(person.memberId)) row.append(icon('check')); section.append(row);
  }
  if (!snapshot.participants.length) section.append(element('p', '', 'No participants enrolled yet. Enrollment is configured by the organizer.'));
  section.append(element('small', 'dashboard-footnote', 'Private budgets stay private. Silence isn’t acceptance.')); return section;
}

function renderItinerary(candidate, nature) {
  const section = panel('Your weekend, stop by stop', 'dashboard-itinerary', 'dashboard-itinerary');
  section.append(element('p', 'dashboard-subtitle', 'Choose a day to explore. Open any stop in Maps.'));
  // UTC is explicit because the public snapshot currently has no trip timezone.
  const note = element('p', 'dashboard-time-note', 'Saved times shown in UTC. Local timing needs confirmation.');
  const groups = new Map();
  for (const item of [...candidate.itinerary].sort((a, b) => new Date(a.startAt) - new Date(b.startAt))) {
    const date = new Date(item.startAt); const key = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown';
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item);
  }
  if (activeDay !== 'all' && !groups.has(activeDay)) activeDay = 'all';
  const tabs = element('div', 'dashboard-day-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Itinerary day');
  for (const [key, label] of [['all', 'Whole trip'], ...[...groups.keys()].map(key => [key, formatDate(`${key}T12:00:00Z`, { weekday: 'short' })])]) {
    const button = element('button', '', label); button.type = 'button'; button.dataset.focusKey = `day:${key}`; button.setAttribute('aria-pressed', String(activeDay === key));
    button.addEventListener('click', () => { activeDay = key; const replacement = renderItinerary(candidate, nature); section.replaceWith(replacement); [...replacement.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === button.dataset.focusKey)?.focus({ preventScroll: true }); }); tabs.append(button);
  }
  section.append(tabs, note);
  for (const [key, items] of groups) {
    if (activeDay !== 'all' && activeDay !== key) continue;
    const day = element('section', 'dashboard-day');
    day.append(element('h3', '', key === 'unknown' ? 'Time to be confirmed' : formatDate(`${key}T12:00:00Z`, { weekday: 'long' })));
    const route = element('ol', 'dashboard-route'); route.setAttribute('aria-label', 'Stops in order');
    for (const item of items) {
      const stop = element('li', 'dashboard-stop');
      const time = element('time', 'dashboard-stop-time', formatDate(item.startAt, { month: undefined, day: undefined, hour: 'numeric', minute: '2-digit', hour12: true })); time.dateTime = item.startAt;
      const content = element('div', 'dashboard-stop-copy');
      content.append(element('h4', '', item.label || item.location));
      if (item.label && item.label !== item.location) content.append(element('p', 'dashboard-stop-location', item.location));
      if (item.notes) content.append(element('p', '', item.notes));
      const meta = element('div', 'dashboard-stop-meta');
      const tags = item.tags || []; const outdoor = nature?.outdoorStops.some(record => record.location === item.location) || tags.some(tag => /outdoor|hiking|nature|park/.test(tag));
      if (outdoor) { const tag = element('span', 'dashboard-tag', 'Outdoors'); tag.prepend(icon('leaf')); meta.append(tag); }
      if (item.travelMinutesEstimate !== undefined) meta.append(element('span', 'dashboard-travel', `${item.travelMinutesEstimate} min estimated travel`));
      const map = element('a', 'dashboard-map', 'Open in Maps'); map.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location)}`; map.target = '_blank'; map.rel = 'noopener noreferrer'; map.prepend(icon('pin')); meta.append(map);
      content.append(meta); stop.append(time, content); route.append(stop);
    }
    day.append(route); section.append(day);
  }
  if (!groups.size) section.append(element('p', '', 'No stops have been added to this option yet. Ask for the itinerary in chat.'));
  return section;
}

function categoryInfo(category) {
  return ({ accommodation: ['Stay', 'stay'], transport: ['Travel', 'travel'], food: ['Food', 'food'], activity: ['Activities', 'activity'], taxes_fees: ['Taxes & fees', 'fees'], other: ['Other', 'other'], contingency: ['Contingency', 'contingency'] })[category] || [category, 'other'];
}

function renderCostChart(candidate) {
  const section = panel('Where the estimate goes', 'dashboard-costs');
  section.append(element('p', 'dashboard-subtitle', 'Group totals by category · upper estimates, not budget limits'));
  const categories = new Map(); let unknown = 0;
  for (const cost of candidate.costs) {
    if (cost.priceStatus === 'unknown') { unknown++; continue; }
    categories.set(cost.category, (categories.get(cost.category) || 0) + cost.highCents);
  }
  // Per-person totals already include contingency; derive the allocated group
  // contingency so it is counted once, irrespective of contract conventions.
  const itemTotal = [...categories.values()].reduce((a, b) => a + b, 0);
  const upperTotal = candidate.perPersonTotals.reduce((sum, total) => sum + total.highCents, 0);
  const contingency = Math.max(0, upperTotal - itemTotal);
  if (contingency) categories.set('contingency', contingency);
  const total = [...categories.values()].reduce((a, b) => a + b, 0);
  const label = element('p', 'dashboard-cost-total'); label.append(element('strong', '', money(total)), element('span', '', unknown ? ' known portion of the group estimate' : ' upper group estimate')); section.append(label);
  const bar = element('div', 'dashboard-cost-bar'); bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', `Category breakdown of ${money(total)}${unknown ? ', excluding unknown prices' : ''}`);
  for (const [category, amount] of categories) { const [name, color] = categoryInfo(category); const segment = element('span', `category-${color}`); segment.style.flexGrow = String(amount); segment.title = `${name}: ${money(amount)}`; if (amount > 0) bar.append(segment); }
  section.append(bar);
  const legend = element('dl', 'dashboard-cost-legend');
  for (const [category, amount] of categories) {
    const [name, color] = categoryInfo(category); const row = element('div'); const term = element('dt', '', name); term.prepend(element('i', `category-${color}`)); row.append(term, element('dd', '', money(amount))); legend.append(row);
  }
  section.append(legend);
  if (unknown) section.append(element('p', 'dashboard-notice', `${unknown} ${unknown === 1 ? 'price is' : 'prices are'} unconfirmed and excluded from this chart. Unknown does not mean free.`));
  const details = disclosure(`${candidate.candidateId}:${candidate.revision}:dashboard-costs`, 'See every cost and per-person estimate');
  for (const cost of candidate.costs) {
    const row = element('div', 'cost-row'); row.append(element('span', '', `${cost.label} · ${cost.allocation === 'personal' ? 'personal cost' : 'shared cost'}`), element('strong', '', cost.priceStatus === 'unknown' ? 'Price unknown' : `${money(cost.lowCents)}–${money(cost.highCents)} · ${cost.priceStatus}`)); details.append(row);
  }
  for (const total of candidate.perPersonTotals) {
    const person = lastSnapshot.participants.find(person => person.memberId === total.memberId);
    const row = element('div', 'cost-row'); row.append(element('span', '', `${person?.displayName || 'Participant'} · total estimate`), element('strong', '', `${money(total.lowCents)}–${money(total.highCents)}`)); details.append(row);
  }
  section.append(details); return section;
}

function renderDashboardFund(fund) {
  const host = document.querySelector('#fund'); host.replaceChildren();
  const section = panel('Our shared trip fund', 'dashboard-fund', 'dashboard-fund');
  const valid = ['requesting', 'partially_funded', 'funded'].includes(fund.status);
  const messages = {
    disabled: 'Fund tracking is off for this trip. The itinerary and cost estimates above are still available.',
    loading: 'Checking the fund for this plan version…',
    not_ready: fund.reason || 'The shared fund becomes available after everyone accepts an eligible plan.',
    unknown: 'The fund is unavailable right now. We’ll retry automatically. No fallback amounts are shown.',
    failed: 'The fund could not be loaded. We’ll retry automatically.',
  };
  if (!valid) {
    section.append(icon('wallet'), element('p', '', messages[fund.status] || 'Fund status is not available yet.'));
    host.append(section); return;
  }
  section.append(element('p', 'dashboard-subtitle', fund.mode === 'nessie' ? 'Nessie sandbox · simulated money only' : 'Local simulation · no real money'));
  const summary = element('div', 'dashboard-fund-summary');
  const progress = element('div', 'dashboard-fund-progress');
  const ratio = Math.min(1, Math.max(0, fund.collectedDollars / Math.max(1, fund.neededDollars)));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('aria-hidden', 'true');
  for (const [name, fraction] of [['fund-ring-track', 1], ['fund-ring-value', ratio]]) {
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    for (const [key, value] of Object.entries({ cx: '60', cy: '60', r: '49', fill: 'none', 'stroke-width': '9', class: name, 'stroke-dasharray': `${fraction * 307.876} 307.876`, transform: 'rotate(-90 60 60)' })) circle.setAttribute(key, value);
    svg.append(circle);
  }
  progress.append(svg, element('strong', '', `${Math.round(ratio * 100)}%`)); progress.setAttribute('role', 'img'); progress.setAttribute('aria-label', `${money(fund.collectedDollars * 100)} collected of ${money(fund.neededDollars * 100)} needed`); summary.append(progress);
  const copy = element('div'); copy.append(element('h3', '', fund.status === 'funded' ? 'Contributions complete' : 'Coming together'), element('p', '', `${money(fund.collectedDollars * 100)} of ${money(fund.neededDollars * 100)} collected`), element('small', '', fund.status === 'funded' ? 'All required contributions are covered.' : `${fund.missingCount} contributions still incomplete. Reminders stay in private chat.`)); summary.append(copy);
  const numbers = element('dl', 'dashboard-fund-numbers');
  for (const [label, amount] of [['Collected', fund.collectedDollars], ['Spent', fund.spending.totalSpentDollars], ['Remaining', fund.remainingDollars]]) { const row = element('div'); row.append(element('dt', '', label), element('dd', '', money(amount * 100))); numbers.append(row); } summary.append(numbers); section.append(summary);
  if (fund.remainingDollars < 0) section.append(element('p', 'dashboard-notice', 'Completed spending is above the amount collected. Check the fund in chat.'));
  if (fund.spending.byCategory.length) {
    section.append(element('h3', 'dashboard-spend-heading', 'Spending against the shared plan'));
    for (const category of fund.spending.byCategory) {
      const [name, color] = categoryInfo(category.category); const row = element('div', 'dashboard-spend-row');
      const label = element('div'); label.append(element('strong', '', name), element('span', '', `${money(category.spentDollars * 100)} spent / ${money(category.plannedDollars * 100)} planned`));
      const meter = element('meter', `category-${color}`); meter.min = 0; meter.max = Math.max(1, category.plannedDollars, category.spentDollars); meter.value = category.spentDollars; meter.setAttribute('aria-label', `${name}: ${money(category.spentDollars * 100)} spent, ${money(category.plannedDollars * 100)} planned`);
      row.append(label, meter, element('small', category.state === 'over' ? 'dashboard-over' : '', category.state === 'over' ? 'Over estimate' : category.state === 'near' ? 'Near estimate' : 'Within estimate')); section.append(row);
    }
  }
  section.append(element('p', 'dashboard-footnote', `Revision ${fund.revision}. Totals come from completed transactions, not the sandbox account balance. Unclassified spend: ${money(fund.spending.unclassifiedDollars * 100)}.`));
  if (fund.staleDollars || fund.unattributedDollars) section.append(element('p', 'dashboard-footnote', `${money(fund.staleDollars * 100)} in earlier-version deposits and ${money(fund.unattributedDollars * 100)} in unattributed deposits are excluded from current contributions.`));
  host.append(section);
}
