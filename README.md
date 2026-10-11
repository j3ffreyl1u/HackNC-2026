# Road-trip planner you text (HackNC 2026)

Text the bot one-on-one over iMessage (Photon Spectrum). It collects each friend's budget, free dates and tastes, asks only what is missing, researches cited options with Gemini and real hotel prices (Google Hotels via SerpApi), gets each person's explicit yes to the exact plan version, and adapts when something changes. Nobody has to organise the group or do the research.

- **Private by design.** Each person's budget stays between them and the bot. Free dates are shared with the group (the bot says so up front) so a date clash can be fixed. A cap is not a contribution promise, and an unknown cost is never treated as zero.
- **Cited, honest prices.** Every option carries its sources. A price that was not found is labelled "typical cost, not a found price"; live availability is never claimed.
- **Exact-version approval.** A change to dates, budget or plan bumps the revision and voids old acceptances.
- **Who covered what (optional, Capital One Nessie sandbox).** Each friend pays with their own simulated account. The bot only reads those accounts, splits shared costs, keeps food personal, asks the buyer once about purchases the plan does not explain, and works out who owes whom. It never moves money. All money is simulated.
- **Trip page.** A read-only page for the saved trip, with a calendar file once the plan is approved.

Direct (one-on-one) messages only: group chat is not supported. See [docs/research.md](docs/research.md), [docs/funding.md](docs/funding.md) and [docs/api.md](docs/api.md).

Quick look, no keys needed: `npm ci`, then `npm run demo:chat` (offline end-to-end story) or `npm run demo:web` (the trip page with a simulated ledger; `DEMO_STATE=gathering|researching|proposed|awaiting_acceptance|approved`). `npx vitest run` runs the test suite.

## Offline demo

Use Node 20.20.2, keep your existing .env, and run:

```powershell
npm install
npm run demo:chat
```

This runs the real conversation and planning modules through three simulated chat participants: targeted questions, $190/$180 options, a private cap reduction to $180, invalidation of old acceptance, fresh approval from all three, and a sourced guide answer. All dates, prices and sources are synthetic. Results persist in data/chat-demo.sqlite. Repeated runs report the saved outcome; set DATABASE_PATH to a new local filename to replay without deleting data.

To view the completed demo:

```powershell
$env:DATABASE_PATH='data/chat-demo.sqlite'
npm run dev
```

Open http://127.0.0.1:3000. Startup bootstraps the configured trip automatically. Mock mode receives no external messages. npm run seed remains an idempotent enrollment helper.

## Connect iMessage

Create a local enrollment config with tripId, groupSpaceId, timeZone and a fixed participants array. Each participant has memberId, displayName, providerUserId (their E.164 phone number, such as +15551234567) and consentedAt (the actual consent timestamp). Set TRIP_CONFIG_PATH to that file and use a separate DATABASE_PATH. Live mode starts gathering; dates, budgets and preferences come from chat rather than demo fixtures.

Set CHAT_MODE=photon, SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET and GEMINI_API_KEY in .env. GEMINI_INTENT_MODEL optionally overrides the language parser model. Keep RESEARCH_MODE=mock for a synthetic research demonstration, or set gemini for the adapted live flow. Run npm run dev.

Live research sends a private expiring link to its requester. Open it on the agent machine and click the research button. Gemini's original answer and Google search suggestions appear together once; neither is saved in the trip. The group receives a manual worksheet derived from agreed chat constraints. Confirm total group estimates in chat:

```text
confirm cost manual-11 v11 lodging $240-$300
```

Use the actual candidate ID, current revision and cost ID shown on the page. Each confirmation advances the revision, so use the new version for the next confirmation. Confirm lodging, transport including parking/tolls, food, activities, fees and contingency. An explicit zero is permitted; unknown is never zero. Confirmed prices are participant estimates. Also confirm itinerary stops in chat:

```text
confirm stop manual-11 v12 Park name | 2026-11-14T10:00:00-05:00 | 2026-11-14T12:00:00-05:00 | hiking
```

Dates must include a timezone and fit the agreed trip. Tags identify which requirements the participant says the stop covers. Stops may not overlap. A stop creates a new revision and requires renewed transport/activity estimates before approval. A worksheet with no confirmed stop cannot be selected or accepted. Required must-dos still block approval when uncovered.

Spectrum is wired and tested with provider-shaped fakes. Real line enrollment, group delivery, DM/reactions and the adapted Gemini display are not live verified here. Links are local because the server binds to loopback; remote access needs authenticated hosting. No site was deployed. Calendar and funding extensions are disabled.

## Checks

```powershell
npm run typecheck
npm exec -- vitest run tests/app tests/conversation tests/availability tests/planning tests/research
npm run build
```

See [docs/integration.md](docs/integration.md) for boundaries and actual verification results.


## DM demo and corrected cap preset

For the shared Photon line, set mode to direct in the live enrollment JSON. groupSpaceId is then a logical trip label; the fixed participants still use actual E.164 phone numbers and recorded consent. Use a fresh database when changing topology. A delivers shared replies as individual DMs and C records every receipt. Coordinate all live messages with Jeffrey.

Run npm run demo:chat -- --realistic-caps for the separate $520/$560/$600 -> $450 scenario. Its $328/$500 prices are explicitly synthetic examples, not newly verified live quotes. The normal offline demo keeps the original affordability acceptance scenario. To replay a scenario after a saved run, choose a fresh DATABASE_PATH. Unknown essential prices still block approval regardless of higher caps.

## Optional: who covered what (simulated)

See [docs/funding.md](docs/funding.md). Nobody pays into a shared account: each friend pays with their own money and the bot reads each friend's own Nessie sandbox account, adds up what each person covered, and works out who would owe whom. It only reads and calculates; it never moves money. Disabled by default; everything is simulated.
