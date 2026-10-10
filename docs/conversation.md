# Conversation and availability (Agent A)

Owned paths: `src/conversation/**`, `src/availability/**`, `tests/conversation/**`, `tests/availability/**`, `docs/conversation.md`.
Product: group-chat road-trip planner (see the travel spec). The old roommate-bill parser is gone; `src/finance/**` is untouched and belongs to others.

## Chat modes (group or one-on-one)
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
- **Selection vs acceptance**: `pick 2` / `pick <id> [v<n>]` -> `select_candidate`; `accept <id> v<n>` or a "yes" -> `accept_candidate`, always bound to the revision in `actionable`. A stale revision, a plan not awaiting acceptance, or "yes" with nothing pending produces no command. "yes" with several pending asks which. "no" records nothing.
- **Reactions**: only positive emoji; the app-resolved target must match an `actionable` item of the same kind, id and revision. Anything else is ignored. A `select` reaction is a preference, not an acceptance.
- Explicit forms (no AI): `show options`, `plan the trip`, `guide: <question>`, `request contributions`.
- Gemini sees: message text, date, channel, timezone, member names, pending field. Never budgets or other members' private history. Output is validated (`intent.ts`); invalid items are dropped. Certainty and hedging are decided by code, not the model. Gemini errors degrade to a clarification (shown only in DMs).

## Verification status (2026-10-10)
| Area | Status |
| --- | --- |
| Parsing, tentative handling, attribution, reactions, privacy, both chat modes (mock) | **Tested**: `tests/conversation/*` (95 conversation/availability tests; full suite 215 passing) |
| Manual availability, free-window suggestions | **Tested** |
| Google free/busy adapter | Tested with a mocked `fetch` only. **Unverified live** (needs per-member OAuth token with free/busy scope) |
| Spectrum payload mapping | Mapped to the 12.10.1 typings, tested with shaped objects. The adapter itself has **not run live** |
| Spectrum DM, live | Verified by hand 2026-10-10 with a throwaway probe (inbound DM with E.164 `senderId`, `space.type` `dm`, reply delivered). Adapter not yet run live |
| Spectrum group chat, live | **Not working on the shared line** (no events reached the app). Photon docs list group creation/events as dedicated-line only. `direct` mode is the fallback |
| Spectrum reactions, live | **Unverified** (needs a thumbs-up on a bot message). Removed-tapback surfacing also unverified |
| Gemini request/response | Request shape from the structured-output docs; response layout extraction is tolerant. **Unverified live**; prompt/schema retargeted but never run against the API |

Known limits: dates are calendar days in the trip timezone (no departure/return times yet); relative dates ("next weekend") are not parsed by rules, only by Gemini with explicit-date output; `src/finance` has 41 pre-existing `tsc` errors unrelated to this module.

## For C
1. Add dependency `spectrum-ts@12.10.1` (only for `CHAT_MODE=photon`; imported lazily). Env names the SDK scaffold uses: `PROJECT_ID`, `PROJECT_SECRET`; plus `GEMINI_API_KEY`, `GEMINI_MODEL`. Node needs `--env-file=.env`.
2. Map a new env (suggest `CHAT_TOPOLOGY=group|direct`) to `TripConfig.mode`.
3. Provide `TripConversationContext` per actor (including `pendingQuestion` and `targetProposal`), and bind each `deliveries[].providerMessageId` to the proposal so reactions resolve.
4. Record the additive `commands` ParseResult and `SendResult` shapes in `docs/integration.md`.

## Run
`npx vitest run tests/conversation tests/availability`
