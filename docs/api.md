# Page API (owned by backend)

The page in `web/` is a **read-only** view. It only calls the endpoints below, all `GET`, all on the app's own origin. The server is `src/app/server.ts`. If the front end needs something that is not here, ask for it in `docs/frontend-requests.md`; do not work around it, and do not edit `src/**`.

Backend promises: existing field names and meanings in this file do not change without a note in `docs/frontend-requests.md` ("API change") and an update here. New optional fields may be added at any time, so the page must ignore fields it does not know.

Run the page with realistic data and no keys: `npm run demo:web` (see the bottom of this file).

## `GET /` and static files
`/` (index.html), `/app.js`, `/reef.js`, `/styles.css`, `/aero-ocean.jpg`, `/aero-meadow.webp`. Add a new static file by adding its name to the allow-list in `server.ts` (ask backend).

## `GET /api/trips/:tripId/snapshot`
`404 {error}` for an unknown trip. Polled every 5 seconds by `app.js`. Never contains anyone's limit, calendar or private answer. The trip id comes from `?trip=` (default `chapel-hill-weekend`).

```
{
  tripId, revision,                       // revision rises on every material change; old approvals are void
  status: 'gathering' | 'researching' | 'proposed' | 'awaiting_acceptance' | 'approved',
  participants: [{ memberId, displayName }],
  selectedCandidate?: Candidate,          // present once someone picked an option
  candidates: Candidate[],                // feasible first; may include a "maybe" (unknown prices) and dropped ones
  acceptances: [{ actorId, candidateId, revision, acceptedAt }],   // who said "I'm in" for the current plan
  fundingStatus: 'disabled' | 'tracking' | 'settled' | 'unknown' | ...,
  nature?: { summaries: OutdoorSummary[], comparison?: string }    // outdoor stops and a driving comparison
}

Candidate = {
  candidateId, revision, title, startAt, endAt,        // ISO times
  dataSource?: 'fixture' | 'live',                     // 'fixture' = made-up demo data: the page must say so
  itinerary: [{ itemId, label?, location, startAt, endAt, travelMinutesEstimate?, tags?, notes?, evidenceIds }],
  costs: [{ costId, category, label, lowCents, highCents, allocation: 'equal_shared' | 'personal', priceStatus: 'verified' | 'estimate' | 'unknown', evidenceIds }],
  contingencyCents,
  perPersonTotals: [{ memberId, lowCents, highCents }],
  evidence: [{ evidenceId, url, title, retrievedAt, kind: 'official' | 'community' | 'estimate' | 'web', claim, uncertainty? }],
  tradeoffs: string[],
  feasibility: { feasible, unknownEssentials: string[], violatedConstraints: [{ constraint, explanation }] }
}
```

Rules the page must keep:
- **Unknown is never zero.** `priceStatus: 'unknown'` shows as "price not found", never `$0`. A candidate with `unknownEssentials` is a "maybe", not affordable.
- **Sources stay visible** (`evidence[].url`, `claim`, `uncertainty`). Do not call every forum post a local; `kind: 'community'` is "one person's experience".
- Money is **integer cents**. Convert only when displaying.
- Fixture data is labelled ("demo data, prices made up"). Live prices are "estimates from web search", not verified.
- `violatedConstraints[].explanation` for budget is a generic sentence on purpose. Never try to work out whose limit it was.

## `GET /api/trips/:tripId/fund`
The "Who covered what" panel. `200` always has `revision`; the page must ignore a response whose `revision` differs from the snapshot's (the plan changed mid-request).

- `{ status: 'disabled', revision }` tracking is off: hide the panel.
- `{ status: 'not_ready', reason, mode, revision }` no approved plan yet: show `reason`.
- `503 { status: 'unknown', error }` the bank could not be read: say so. Never show numbers from an earlier read.
- `409` the plan changed during the request: refetch.
- Otherwise:

```
{
  status: 'tracking' | 'settled',          // 'settled' = everyone is even and something was shared
  mode: 'mock' | 'nessie',                // 'nessie' = Nessie sandbox. Both are SIMULATED money; the panel must say so
  revision,
  expectedEachDollars,                    // what the plan expects each person's share of shared costs to be
  sharedSpentDollars,
  members: [{ memberId, name, coveredDollars, fairShareDollars, netDollars,    // net > 0 is owed to them, < 0 they owe
              byCategory: [{ category, dollars }] }],
  transfers: [{ from, to, dollars }],     // names; "if the trip ended now". Calculated only
  spending: { byCategory: [{ category, plannedDollars, spentDollars, state: 'within' | 'near' | 'over' }],
              overCategories, unclassifiedDollars, totalSpentDollars, contingencyDollars },
  unclassifiedDollars,                    // left out of the split (no category)
  unattributedDollars                     // from an account not on the trip, never credited
}
```
Whole dollars. Categories here: `accommodation`, `fuel_parking_tolls`, `food`, `activities`, `taxes_fees`, `other` (note `fuel_parking_tolls`/`activities`, unlike the snapshot's cost categories). Food is personal and is not in `members[].byCategory`. The page must never imply the bot moves money.

## `GET /api/trips/:tripId/plan.ics`
`200 text/calendar` once the trip is `approved` with a selected plan at the current revision; `409 {error}` before that. The approval text message links to it. The page may offer it as "Add to calendar" when `status === 'approved'`.

## Not available to the page (on purpose)
Any member's budget or limit, calendar details, who a budget violation belongs to, message text, phone numbers.

## Working with the page locally
```
npm run demo:web                         # http://127.0.0.1:3000/?trip=chapel-hill-weekend, approved demo trip, SIMULATED ledger
DEMO_LEDGER=empty|sample|uneven|even npm run demo:web     # what the pretend banks report
DEMO_FUND=off npm run demo:web           # tracking disabled: the fund panel must be hidden
PORT=3100 DATABASE_PATH=data/other.sqlite npm run demo:web   # another port / another saved trip
```
`demo:web` only serves the page. It has no chat, no research and no keys. To see other trip states (gathering, proposed, awaiting acceptance), ask backend for a `DEMO_STATE` option in `docs/frontend-requests.md`.
