# Finding N.E.M.O

**Next Excursion Mapped Out.** A trip planner you text.

Planning a trip with friends usually means one person ends up doing all the work: chasing everyone for dates, guessing what people can afford, researching places, and then keeping track of who paid for what. Finding N.E.M.O takes that job over. Each friend texts the same assistant over iMessage, and it collects what it needs from each person, finds options that work for the whole group, gets everyone to agree on one plan, and keeps track of shared spending afterwards.

Built at HackNC 2026.

---

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Privacy and honesty](#privacy-and-honesty)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Testing](#testing)
- [Built with and credits](#built-with-and-credits)
- [Known limitations](#known-limitations)
- [Team](#team)

---

## How it works

1. **Everyone texts the assistant.** Each friend messages the same number from their own phone, in a private one-on-one thread. There is no group chat to manage.
2. **It asks only for what is missing.** Starting city, driving or flying, how many nights, where to go, free dates, a personal budget and what each person enjoys. One short question at a time, and it accepts messy answers like "i can do like 400 tops" or "the weekend of Nov 21".
3. **It finds options that fit everyone.** Once the basics are settled, it researches destinations, prices each option against every person's own limit, and sends back two cited options with a cost breakdown.
4. **Everyone agrees on the same plan.** Someone picks an option, then each person says "I'm in". If a detail changes (dates, budget, nights), the old approvals no longer count and the plan is rechecked.
5. **It tracks who covered what.** After the trip is approved, friends can text things like "I just paid $60 for gas". The assistant records it in that person's simulated bank account, splits shared costs evenly, and works out who owes whom.

A read-only trip page shows the itinerary, costs, sources, who has agreed, and the spending tally.

## Features

**Conversation**
- One-on-one iMessage threads for every participant, through Photon Spectrum.
- Rules handle common phrasing; Gemini handles everything else and is never trusted blindly (its output is validated before anything is saved).
- The assistant speaks for everyone: "ask Mason if he has a car", "tell Mason I'm bringing snacks" and "remind Mason to lock it in" are passed on, and answers come back.
- Follow-up questions about the options: "which is cheaper and by how much?", "what does option 2 include?", "how long is the drive?".
- Disagreements (two starting cities, different trip lengths, driving versus flying) are surfaced once and settled in chat.

**Planning**
- Driving or flying. A driving trip asks whose car and prices fuel; a flying trip needs no car and uses an estimated airfare instead.
- Every option is checked against each person's own maximum, using the top of each price range so nobody is shown a price their limit would reject.
- Exact-version approval: a change to a material detail starts a new revision and clears earlier approvals.
- Approved plans can be downloaded as a calendar file.

**Research**
- Destination research with Gemini and Google Search grounding. Every option keeps its sources.
- Real hotel prices from Google Hotels through SerpApi when a key is configured.
- Anything that could not be found is labelled "typical cost, not a found price" instead of being guessed silently.

**Shared spending (simulated)**
- Each friend has their own Capital One Nessie sandbox account. Purchases logged in chat are written there and read back to compute the tally.
- Shared costs (lodging, gas or flights, activities, fees) are split evenly. Food stays personal unless the buyer says it was for everyone.
- "Who covered what?", "remind everyone" and "wrap up the trip" answer from the ledger. Settle-up amounts are calculated only; nothing is ever paid or transferred.

## Privacy and honesty

These rules are enforced in code and covered by tests.

- **Budgets stay private.** A person's maximum is only ever discussed with that person. It is never relayed to anyone else, never shown on the trip page, and left out of the facts the language model answers from.
- **Free dates are shared** with the other participants (the assistant says so up front) so a date clash can be resolved.
- **No invented numbers.** Answers written by the language model are rejected if they contain an amount that is not in the plan's own facts. Unknown prices are never treated as zero.
- **No real money.** All banking runs against the Nessie sandbox with fake accounts. The assistant never books, pays or holds funds.

## Architecture

```
  iPhone (iMessage)
        │
        ▼
  Photon Spectrum ──► Conversation layer ──► Planner ──► Research
                      (rules + Gemini)       (readiness,  (Gemini + Google Search,
                                              budgets,     SerpApi hotel prices)
                                              revisions)
                              │                  │
                              ▼                  ▼
                         App runtime ◄──────► SQLite (trip state, revisions,
                              │                        evidence, message outbox)
                              ├──► Trip page (read-only web view)
                              └──► Nessie sandbox (per-friend accounts, read for the ledger)
```

- **Conversation** turns each text into structured facts or commands. Clear phrasing is handled by deterministic rules; the rest goes to Gemini with a strict response schema.
- **Planning** is pure TypeScript with no database or network access. It decides what is still missing, validates every candidate against each person's limit in integer cents, and manages revisions and approvals.
- **Research** finds and prices options. It runs outside any database transaction, and results for an outdated revision are discarded.
- **The app runtime** wires everything together, stores state in SQLite, and sends replies through a durable outbox so a retried message is never sent twice.

## Project structure

```
src/
  app/            Runtime, HTTP server for the trip page, configuration, adapters between layers
  contracts/      Shared types used across layers
  conversation/   Message parsing, date and budget rules, Gemini intent model, Spectrum transport, reply voice
  planning/       Readiness checks, budgets, revisions, candidate generation, ranking, ledger math, calendar export
  research/       Gemini research provider, pricing, SerpApi hotel lookups, offline fixtures
  funding/        Nessie sandbox reader, fund service, chat purchase logging and demo sequence
  storage/        SQLite repository and message outbox
  availability/   Manual availability and an optional Google Calendar free/busy adapter
web/              Trip page: plain HTML, CSS and JavaScript with a canvas-drawn reef scene
scripts/          Offline chat demo, trip page demo, Nessie simulator, seeding and diagnostics
tests/            Unit, integration and scripted-conversation tests (Vitest)
```

## Getting started

### Requirements

- Node.js 20 (see `.nvmrc`)
- npm

### Run it offline (no keys needed)

```bash
npm ci
npm run demo:chat     # three simulated friends plan a trip end to end in the terminal
npm run demo:web      # the trip page with simulated data at http://127.0.0.1:3000
```

`demo:web` accepts `DEMO_STATE=gathering|researching|proposed|awaiting_acceptance|approved` to preview each stage. All prices, dates and sources in offline mode are synthetic and labelled as such.

### Run it live

1. Copy `.env.example` to `.env` and fill in the keys for the services you want (see [Configuration](#configuration)).
2. Create a trip file that lists each participant's name and phone number, and point `TRIP_CONFIG_PATH` at it. The file needs `mode: "direct"`, a `tripId`, a `groupSpaceId` label, a `timeZone` and the `participants` array (`memberId`, `displayName`, `providerUserId` as an E.164 phone number, `consentedAt`).
3. For shared spending, create sandbox accounts once:
   ```bash
   npm run simulate:fund -- manifest.json --provision --execute
   ```
   This writes `data/simulated-accounts.json`. Run it once; rerunning creates duplicates.
4. Start the app:
   ```bash
   npm run dev
   ```

For links in texts to open on a phone, set `PUBLIC_BASE_URL` to an HTTPS address that reaches this machine, for example a `cloudflared tunnel --url http://127.0.0.1:3000` address.

## Configuration

All settings live in `.env` (see `.env.example`). Everything defaults to offline mock modes.

| Variable | Purpose |
| --- | --- |
| `CHAT_MODE` | `mock` (default) or `photon` for live iMessage |
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | Photon Spectrum credentials |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Gemini for language understanding and research |
| `RESEARCH_MODE` | `mock` (default), `gemini` or `live` |
| `VOICE` | `gemini` rewords outgoing replies so they read like a friend texting; `off` by default |
| `SERPAPI_API_KEY`, `SERPAPI_MAX_SEARCHES` | Optional real hotel prices from Google Hotels |
| `FUNDING_MODE` | `disabled` (default), `mock` or `nessie` |
| `NESSIE_API_KEY`, `NESSIE_BASE_URL` | Capital One Nessie sandbox |
| `NESSIE_ACCOUNTS_PATH`, `NESSIE_MERCHANTS_PATH` | Files written by the simulator mapping people to sandbox accounts |
| `LOG_PURCHASES` | `on` lets people log purchases by text after approval |
| `PUBLIC_BASE_URL` | Address phones can open for trip-page links |
| `TRIP_CONFIG_PATH`, `DATABASE_PATH`, `PORT` | Trip file, SQLite file and web port |

## Testing

```bash
npm run typecheck
npm test
npm run build
```

The suite has over 1,500 tests. Beyond unit tests, it drives the real conversation, planner and runtime through a simulated phone line to check complete conversations: gathering details, disagreements, picks, approvals, relays and purchase logging. Money calculations are also checked with seeded randomised tests (shares always add up to the cent and settle-up amounts always balance).

## Built with and credits

**Language and runtime:** TypeScript on Node.js 20, SQLite through [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [tsx](https://github.com/privatenumber/tsx) for running TypeScript, and [Vitest](https://vitest.dev) for tests.

**External APIs and services**
- [Photon Spectrum](https://photon.codes) (`spectrum-ts`): sends and receives the iMessage conversations.
- [Google Gemini API](https://ai.google.dev): understands free-form messages, answers questions about the options from the plan's own facts, rewords replies, and researches destinations with [Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search).
- [SerpApi](https://serpapi.com) Google Hotels API: real hotel prices for live research, when configured.
- [Capital One Nessie](https://api.nessieisreal.com) sandbox API: simulated per-friend bank accounts and purchases. No real money is involved.
- Google Maps search links on the trip page open place names in Google Maps.
- Google Calendar API: an optional free/busy adapter, off by default and not used in the demo.

**AI assistance in development:** We used AI coding assistants, including Anthropic's [Claude Code](https://claude.com/claude-code), to help write, test and review code. All product decisions and the final code were reviewed by the team.

**Design:** The reef scene on the trip page is drawn in code on a canvas; no generated or stock imagery is used. The interface uses system fonts, with Inter named as a fallback.

## Known limitations

- **Flight prices are estimates.** Flying trips use a typical round-trip fare per person, clearly labelled, rather than a live fare lookup.
- **Research prices are estimates.** Prices come from web search and hotel listings; they are not bookable quotes.
- **One-on-one threads only.** Group iMessage chats are not supported.
- **A pick cannot be switched** once it is made. Changing a detail (dates, nights, a budget) brings fresh options instead.
- **Some memory is kept in the running process**, such as a question waiting to be relayed or a purchase waiting for confirmation, so it is lost if the app restarts.

## Team

- Jeffrey Liu
- Mason Wang
- Cameron Kalista
