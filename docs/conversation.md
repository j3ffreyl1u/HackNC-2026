# Conversation and availability (Agent A)

Owned paths: `src/conversation/**`, `src/availability/**`, `tests/conversation/**`, `tests/availability/**`, `docs/conversation.md`.
Product: group-chat road-trip planner (see the travel spec). The old roommate-bill parser is gone; `src/finance/**` is untouched and belongs to others.

## Chat modes (group or one-on-one)
**Decision (2026-10-10): the product runs in `direct` mode.** Every participant texts the same assistant number from their own phone, in their own private thread; there is no group chat. `group` mode is still in the code and tested with mocks, but it is unused and unverified live. Anything C/B ship should assume `direct`: shared announcements go out as separate DMs, nobody sees anyone else's messages, and a budget must never appear in a message sent to more than one person.

`TripConfig.mode` selects the topology; everything else (parsing, privacy, command shapes) is identical.

| Mode | Inbound accepted | `group` audience outbound | Use when |
| --- | --- | --- | --- |
| `group` | enrolled members in `groupSpaceId`, plus their DMs (private limits) | one message to the group | a dedicated Photon line supports iMessage groups |
| `direct` | DMs from enrolled members only (group events dropped) | an individual DM to **every** member | shared line / group events don't arrive, or a 1:1 demo |

Pivoting is a config change (`mode: 'direct'`). In `direct`, `groupSpaceId` is only a logical label that the app keeps using for "the group"; it is never sent to the provider. A trip with one member is plain one-on-one. In `direct` every parser reply is private. `sendMessage` returns every individual delivery (`deliveries`) so the app can bind reactions per member message, and `failedMemberIds` for partial failure (it throws only if nobody was reached).

## Public interface
`createConversationService({ trip, intentModel, messenger, getConversationContext })` returns `parseInbound(message, context?)`, `sendMessage`, `start`, `stop`. Types are in `src/conversation/contracts-local.ts` (mirrors the spec; **C should replace it with re-exports from `src/contracts` once published**).

- `getConversationContext(actorId, spaceId, targetMessageId?)` is supplied by C (backed by B's state); the optional `context` argument to `parseInbound` overrides it. The context carries: `actionable` (items this member can pick/accept now, with revision), `targetProposal` (the reaction's target resolved by the app) and `pendingQuestion.field` (what we last asked this member, so a bare "200" or "Oct 17-19" has meaning).
- `ParseResult` adds an additive `commands` variant (`{ commands, clarification? }`) for messages with several facts or a fact plus a question. One command and nothing else is still `command`. Contract change for C to record.
- `TripCommand` ids are `tripId:eventId:action[:field]`, so a retried event yields identical ids.
- Availability: `AvailabilityProvider.getBusyIntervals(memberId, from, to)`; `createManualAvailabilityProvider`, `suggestFreeWindows` (suggestions only), optional `createGoogleFreeBusyProvider`.

## Behaviour
- Actor comes only from the enrolled `providerUserId`. Unknown senders, unrelated groups, own messages and removed reactions are dropped.
- **Constraints** (deterministic, per sentence, no AI): budget in cents, availability windows (`Oct 17-19`, `2026-10-17 to 2026-10-19`, `10/17-10/19`), nights, origin, region (`within 3 hours`), vehicle access, preferences, must-dos/dietary. Gemini is only used when the rules find nothing.
- **Tentative wording**: budget and dates are never recorded from hedged text (`maybe`, `might`, `?`, ...): the sender is asked to state it plainly. Low-stakes fields (preferences, region, origin, duration, transport) from hedged text are emitted with `certainty: 'tentative'`. Ordinary chatter produces nothing and the bot stays quiet in a group.
- **Budgets**: only the sender's own; a message naming another member never sets a budget. Budget confirmations/questions are always sent privately and never contain a group-visible amount.
- **Parsed extras for readiness**: a `region` update also carries `maxTravelMinutes` when a drive limit is stated ("within 3 hours" -> 180), and a `transport` update carries `vehicleAvailable` (`true`/`false`) when clear. Both are omitted when unclear, never guessed. The free-text `value` is kept alongside.
- **Confirming a hedged budget**: the reply carries `expects: { field: 'budget', valueCents }`. The app stores it per member and passes it back as `pendingConfirmation`; a later "yes" then records exactly that amount (confirmed), "no" asks again. With nothing pending, "yes" is ignored.
- **Selection vs acceptance**: `pick 2` / `pick <id> [v<n>]` -> `select_candidate`; `accept <id> v<n>` or a "yes" -> `accept_candidate`, always bound to the revision in `actionable`. A stale revision, a plan not awaiting acceptance, or "yes" with nothing pending produces no command. "yes" with several pending asks which. "no" records nothing.
- **Reactions**: only positive emoji; the app-resolved target must match an `actionable` item of the same kind, id and revision. Anything else is ignored. A `select` reaction is a preference, not an acceptance.
- Explicit forms (no AI): `show options`, `plan the trip`, `guide: <question>`, `request contributions`.
- Gemini sees: message text, date, channel, timezone, member names, pending field. Never budgets or other members' private history. Output is validated (`intent.ts`); invalid items are dropped. Certainty and hedging are decided by code, not the model. Gemini errors degrade to a clarification (shown only in DMs).

## One question at a time (changes in B's and C's files, proposed by A)
Live test 2026-10-10: two people saying "let's plan a trip" 3 seconds apart got 4 shared questions + a long summary each, and after every "Got it" the conversation stalled. Fixes on `integration/combined-v3`, for B/C to adopt or replace:
- **B `planning/questions.ts` `selectQuestions`**: one question per person at a time. A shared question blocks all further questions to everyone until answered (or the 12h cooldown passes); a private question blocks only its person. A second person's start request gets only the private summary.
- **B `planning/readiness.ts` `describeGaps`**: "Here's what I need to plan this: ..." when nothing has been recorded yet; "I'm still waiting on ..." afterwards.
- **Contract (C) `ParseResult.commands.acknowledgement`**: a plain "Got it" is separate from `clarification` (a real question). C's runtime sends the acknowledgement FIRST and still asks the next question; a `clarification` still pauses follow-ups.
- **C `storage/sqlite-repository.ts`**: the outbox is drained in insertion order (`ORDER BY queued_at, rowid`); it used to tie-break on a hashed delivery id, so messages sent in the same moment came out in random order.

## Rules first, then Gemini (automatic handoff)
Each message goes through the deterministic rules first (exact, instant, no network). The rules also report which sentences and long clauses they did **not** understand; exactly those are handed to Gemini automatically, and its validated answer is merged with the rules' (rules win per field, and Gemini is told which fields are already captured). Small talk ("thanks!", "hey", "lol") is answered without a model call, and a request tucked into a longer message ("..., can you show us some options?") is understood by rule. If Gemini says "clarify" it is asked once more; if it errors, the user gets the friendly help message (in a DM) instead of silence.

**Simulated live test** (`tests/conversation/corpus.ts`, 135 realistic DMs with expected outcomes, including adversarial ones):
- `corpus.test.ts` (always runs, no network): rules alone must get every `rules: true` case right, and every other case must have been handed to the model.
- `corpus.live.test.ts` (real Gemini): `RUN_LIVE_GEMINI=1 GEMINI_API_KEY=... GEMINI_MODEL=... CORPUS_REPORT=/tmp/report.txt npx vitest run tests/conversation/corpus.live.test.ts`. Result 2026-10-10 with `gemini-3.8-flash`, two runs: **134 pass, 0 fail, 1 soft miss** ("free Thanksgiving week"). Soft cases are judgement calls and never fail the run. Add every message that goes wrong in a real test to the corpus.

## Join codes (my half, off by default)
A friend can text the assistant `join 4F7K` (also `JOIN-4F7K`, `join code 4F7K`, `use code 4F7K to join`) to ask to be added. A code must contain a digit, so "join us" or "join now" are never codes.
- `createConversationService({ ..., joinCodes: true })` lets a DM from a number that is **not enrolled** through, and only if the text is exactly a join request. It arrives as `senderId: 'guest:<number>'`; everything else from strangers is still dropped, and a guest can never do anything but join.
- The parser then emits a command with action `{ kind: 'join_trip', code, providerUserId }`. **This action is not in the shared contracts yet**, so it is typed loosely and stays off until C adds it.
- An enrolled member who sends a code gets a friendly "you're already on this trip".
- **C still has to:** add `join_trip` to the contracts; check the code is valid and unused; record consent (`consentedAt`) before enrolling; send the guest a reply (the outbound audience currently needs a `memberId`, so it needs a provider-number audience for guests); then set `joinCodes: true`.

## Verification status (2026-10-10)
| Area | Status |
| --- | --- |
| Parsing, tentative handling, attribution, reactions, privacy, both chat modes (mock) | **Tested**: `tests/conversation/*` (95 conversation/availability tests; full suite 215 passing) |
| Manual availability, free-window suggestions | **Tested** |
| Google free/busy adapter | Tested with a mocked `fetch` only. **Unverified live** (needs per-member OAuth token with free/busy scope) |
| Spectrum payload mapping | Mapped to the 12.10.1 typings, tested with shaped objects. The adapter itself has **not run live** |
| Spectrum DM, live | **Verified 2026-10-10 with this repo's adapter** (`spectrum.ts` + normalizer + parser, driven by a throwaway probe outside the repo): inbound DM parsed to a command, replies delivered, send returns a provider message id. One `ECONNRESET` on the stream recovered by itself |
| Spectrum group chat, live | **Not pursuing (decision 2026-10-10).** Did not work on the shared line (no events reached the app). Photon docs list group creation/events as dedicated-line only. `direct` mode is the fallback |
| Spectrum reactions, live (DM) | **Verified 2026-10-10**: a thumbs-up on a bot message arrived as a reaction bound to that message's provider id and parsed to `select_candidate`. Removed-tapback surfacing still unverified |
| Gemini, live | **Verified 2026-10-10** with `gemini-3.8-flash` via `models/{model}:generateContent` (JSON-schema output): chatter -> none; dates, preferences, dietary, spelled-out budget, plan requests and guide questions extracted; prompt-injection text and "Alex said his budget is 50" produced nothing. The first guessed endpoint (Interactions) and `gemini-2.5-flash` (closed to new users) returned 404. Eight hand-written messages, not a benchmark |

Known limits: dates are calendar days in the trip timezone (no departure/return times yet); relative dates ("next weekend") are not parsed by rules, only by Gemini with explicit-date output; `src/finance` has 41 pre-existing `tsc` errors unrelated to this module.

## For C
1. Add dependency `spectrum-ts@12.10.1` (only for `CHAT_MODE=photon`; imported lazily). Env names the SDK scaffold uses: `PROJECT_ID`, `PROJECT_SECRET`; plus `GEMINI_API_KEY`, `GEMINI_MODEL` (use `gemini-3.8-flash`; check `GET /v1beta/models` since older models close to new users). The Spectrum names in the team `.env` are `SPECTRUM_PROJECT_ID`/`SPECTRUM_PROJECT_SECRET`, so C should read those (or map them). Node needs `--env-file=.env`.
2. Map a new env (suggest `CHAT_TOPOLOGY=group|direct`) to `TripConfig.mode`.
3. Provide `TripConversationContext` per actor (including `pendingQuestion`, `pendingConfirmation` from the last reply's `expects`, and `targetProposal`), and bind each `deliveries[].providerMessageId` to the proposal so reactions resolve.
4. Record the additive `commands` ParseResult and `SendResult` shapes in `docs/integration.md`.

## Run
`npx vitest run tests/conversation tests/availability`
