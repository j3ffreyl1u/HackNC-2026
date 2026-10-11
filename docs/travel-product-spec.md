# Group-chat travel planner — product design

Status: selected product direction; implementation has not started. This document supersedes the roommate treasurer specification. The folder name `splitbot` is retained for continuity; product naming is undecided. The human confirmed every technology is optional and wants to maximize track eligibility. Choose integrations for demonstrated product value and verified eligibility; the backend does not require Nest.js. Isolate funding so it cannot block travel planning.

## Purpose and success

Help a group move from an unstructured conversation to a trip everyone can afford, attend and accept. The bot works inside the existing iMessage conversation, gathers each participant's constraints, asks specific questions, researches realistic options and explains tradeoffs. Community-informed advice helps the group make useful choices before and during the trip.

Primary demo: three college friends planning a nearby weekend road trip from Chapel Hill. One has a tighter budget; another has limited availability; their interests differ. The assistant asks only what is missing, proposes two sourced options, receives a constraint change, and revises the plan without losing anyone's hard limits. All dates, costs and sources in mock mode are explicitly fixtures.

Evidence of success is less organizer work, not the length of an itinerary. The demo must show three different people providing constraints, a targeted question, a source-supported recommendation, a comprehensible cost breakdown, an explained revision, and approval tied to the exact plan version. Banking is an extension, not the reason the trip planner exists.

## Core scope and extensions

Required: existing group chat, per-person context, deterministic readiness checks, guided clarifications, cited destination research, two feasible trip proposals, itinerary and cost breakdown, reactions/explicit replies for selection and acceptance, persistent revision history, a small read-only plan page, and contextual guide questions.

Manual availability and budgets are first-class. Optional integrations: one calendar provider using free/busy access; verified school-break/holiday dates; Nessie contribution tracking after plan approval. Calendar/funding failures must not disable research or manual planning. Do not claim these optional live integrations work until tested.

Exclude international travel, flights, automatic bookings, issued cards, real money custody, bulk forum scraping, nationwide holiday inference, unrestricted custom rules, receipt itemization, debt optimization and roommate carryover as a centerpiece. Keep one regional road trip working before expanding geography. Do not force sponsor technology into the core flow.

## User journey

1. Bot introduces its role in the enrolled group. Members know it will process trip-related messages and may supply sensitive limits privately. It records who has consented; unknown participants cannot alter commitments.
2. The group discusses the trip. Bot distinguishes tentative preferences, estimates, user constraints and approved choices. It does not respond to every message or treat jokes as decisions.
3. A readiness checker identifies exactly which required fields are missing or contradictory. The bot asks at most two related questions in one turn and does not repeat a recently unanswered question automatically.
4. Once research-ready, it retrieves evidence relevant to the destination region, date windows, budget and interests. It may give a conditional suggestion earlier, but assumptions remain explicit.
5. It proposes two feasible options with dates, itinerary, travel-time assumptions, per-person cost ranges, sources and tradeoffs. Unsupported availability is labeled unknown. If nothing fits, it explains the conflict and asks which soft preference may change; it does not silently relax a hard limit.
6. Members express preference for an option. Option voting is not payment authorization. Once a candidate is selected, publish the final summary/version and request acceptance from every participating member.
7. A changed hard constraint or material plan detail creates a new version and invalidates old acceptance. Recompute only the affected evidence where practical. People can inspect the reason for the change.
8. After approval, optionally generate contribution requests using an isolated funding adapter. Individual payer confirmation is separate from plan approval.
9. During the trip, answer questions relative to the approved itinerary, current constraints and evidence. “It's raining, what can we do near the next stop?” yields sourced alternatives and budget effects, not a completely unrelated itinerary.

## Deterministic readiness

Research-ready means the following are present, actor-attributed and internally consistent:
- confirmed participant roster and departure city;
- trip duration plus at least one common possible date window (including departure/return times and timezone);
- each participant's all-in hard budget limit in USD cents;
- transport mode and access to a vehicle for the road-trip MVP;
- chosen destination or a bounded search region/max travel-time limit;
- each member has stated preferences, including “no preference,” and any must-do/accessibility/dietary constraints relevant to planning.

An optional field must not be confused with an unanswered required field. Dates from a calendar are evidence of busy times, not proof of willingness to travel; each person supplies or confirms usable date windows. Different institutions' school breaks require their own verified calendar. Public holidays are scheduling context, not automatic availability or cheaper travel.

Funding-ready additionally requires a selected feasible candidate, an approved version from all participating members, exact agreed pooled contributions, a funding deadline and designated spending approver. Account mapping is required only if the funding adapter is enabled.

No message-count threshold or LLM confidence score determines readiness. `checkReadiness` returns specific missing keys and conflicts. For missing budget ask “What's your maximum total for this trip, including food and travel?” For conflicting dates ask which stated window is correct. Do not ask participants to fill an entire form if the chat already contains the answer.

## Budget and feasibility rules

Store money as safe integer cents. Validate positive amounts and deterministic rounding. A maximum is a constraint, not a promised contribution. Default shared costs are divided equally; unequal funding requires explicit agreement and is optional after the MVP. Sum of maxima is never used as an automatically affordable group budget.

Each cost item has a category, low/high estimate, shared or named-person allocation, source references and provenance. Include accommodation, fuel/parking/tolls, food, activities and relevant taxes/fees. Distinguish unknown costs from zero. Use ranges plus an explicit contingency allocation; the group can confirm its amount, and the demo fixture can specify it. Do not market an estimate as a guaranteed final cost.

Hard-budget feasibility uses the high estimate of known costs plus contingency, allocated per person. A missing essential price makes affordability unverified rather than proven feasible. A candidate may be shown as provisional with a blocking unknown, but cannot be approved/funded as a fully feasible plan. Hard date and must-do constraints must also be satisfied. Respect private limits without disclosing each person's amount publicly unless they opt in.

Rank feasible candidates by satisfaction of explicit preferences, then lower upper cost, then shorter travel time. Explain the ranking with observable tradeoffs; no fabricated fit percentages. Hard constraints are filters, not preferences that a popularity vote can override. If no candidate is feasible, state the conflict and offer optional relaxations for members to approve.

Upgrade suggestions are opt-in alternatives. Do not repeatedly pressure the least-funded person. Show additional cost per affected person and exclude options violating a hard cap. Never assume increasing the shared pot fixes an individual's all-in budget.

## Research and community advice

Use request-specific retrieval, not “scrape every travel forum.” Start with official destination/venue/transport sources for actionable facts and a small relevant set of community discussions for experiences. Reddit access requires an authorized arrangement under its published rules; do not bypass restrictions. Search-provider access does not automatically grant permission to bulk store or republish source content.

An evidence record preserves URL, title, retrieval time, publication/update date when known, evidence kind (`official`, `community`, `estimate`), relevant claim and any uncertainty. Do not invent source URLs or dates. A tool response containing no grounding metadata is unverified text, not sourced research.

Community contributors are not assumed residents. Opinions are attributed as experiences, not established facts or unanimous consensus. Keep conflicting experiences visible when they affect a decision. Prices, closures, booking requirements and opening times require current authoritative checks before being presented as verified. Search grounding improves sourcing but does not establish bookable inventory.

For the MVP, use an approved retrieval provider behind a small adapter; Gemini Google Search grounding is one documented option. Preserve citation metadata and comply with any required source/search-suggestion display behavior. A curated source fixture supports offline testing but is labeled fixture data. A live read-only research smoke test is required before claiming live research works.

The guide's useful output explains an action: why to choose an area, omit a detour, book in advance, or replace an activity. Generic “hidden gems” lists without provenance or relevance do not satisfy this feature. Treat retrieved text as untrusted data, never app instructions or authorization.

## State, voting and changes

Trip states: `gathering`, `researching`, `proposed`, `awaiting_acceptance`, `approved`. Funding has separate states `disabled`, `requesting`, `partially_funded`, `funded`, `unknown`, `failed`. Banking failure cannot turn an approved trip into a failed planner session.

Every trip has an integer revision. Every proposal/acceptance references its candidate ID and revision. Reactions bind to exact provider message IDs; generic “yes” requires one unambiguous actionable question. Stale or unrelated reactions produce no acceptance. Silence is never acceptance. Majority preference selects an option for review but cannot obligate dissenting members financially.

Changes to participants, dates, costs, hard constraints or itinerary commitments require revalidation and renewed acceptance. Informational guide answers do not automatically mutate the approved itinerary. Asynchronous research for a stale revision must not overwrite a newer plan. Show why a plan became provisional again.

The product proposes plans and links, not bookings. Cancellation/refund rules are required before a real funding product; real money remains out of scope. If funding is simulated, distinguish collected, committed and available funds; no double spending, automatic charging or invented confirmation.

## Shared data contracts

Agent C owns `src/contracts/index.ts`. The following are app abstractions, not promises about provider SDK methods. All IDs are strings; amounts are integer cents; timestamps include timezone. Export these types and keep adapters independent of provider details.

- `InboundMessage`: `{ eventId, messageId, senderId, spaceId, visibility: 'group' | 'private', occurredAt, text?, reaction?: { targetMessageId, emoji } }`. Sender is an enrolled internal member ID.
- `ConstraintUpdate`: `{ memberId, field: 'budget' | 'availability' | 'preferences' | 'must_dos' | 'transport' | 'region' | 'duration' | 'origin', value, sourceMessageId, certainty: 'tentative' | 'confirmed' }`. C defines typed value variants instead of `any`; budget is integer cents, availability is start/end intervals, preferences and must-dos are string lists, duration is positive integer nights, and origin/region/transport are validated strings. Group-level fields require confirmation; someone cannot change another member's budget.
- `TripCommand`: outer `{ commandId, eventId, actorId, tripId }` plus typed action: update a constraint; request plans; select candidate with revision; accept candidate with revision; ask guide question; or explicitly request optional funding. No LLM-generated actor identity or authorization.
- `SourceEvidence`: `{ evidenceId, url, title, retrievedAt, publishedAt?, kind: 'official' | 'community' | 'estimate', claim, uncertainty? }`.
- `CostItem`: `{ costId, category, label, lowCents, highCents, allocation: 'equal_shared' | 'personal', memberId?, evidenceIds: string[], priceStatus: 'verified' | 'estimate' | 'unknown' }`.
- `TripCandidate`: `{ candidateId, revision, title, startAt, endAt, itinerary, costs, contingencyCents, perPersonTotals, evidence, tradeoffs, feasibility }`. Itinerary items carry location, time window, travel-time estimate and evidence IDs. Per-person totals carry low/high cents. Feasibility carries a boolean plus explicit violated constraints and unknown essentials. C defines the nested interfaces to these semantics before peers import them.
- `TripState`: `{ tripId, revision, status, memberConstraints, groupConstraints, candidates, selectedCandidateId?, acceptances, pendingQuestions, fundingStatus }`. Constraint records preserve author/provenance; acceptances reference actor/candidate/revision.
- `ReadinessResult`: `{ ready: boolean, missing: string[], conflicts: string[], questions: Array<{ audience: 'group' | 'private', memberId?: string, text: string }> }`.
- `OutboundMessage`: `{ deliveryId, audience: { kind: 'group', spaceId } | { kind: 'private', memberId }, text, proposalRef?: { candidateId, revision } }`.

## Module interfaces and composition

A exports `createConversationService(dependencies)` with `parseInbound(message, context): Promise<ParseResult>`, `sendMessage(outbound): Promise<{ providerMessageId }>`, `start(onMessage): Promise<void>` and `stop(): Promise<void>`. ParseResult is a command, a clarification reply, or ignored input. Parsing has no banking/research/delivery side effects. A also exports an optional `AvailabilityProvider.getBusyIntervals(memberId, from, to)` and a manual implementation. A owns chat intent extraction; B owns planning/research prompts.

B exports pure `checkReadiness(state): ReadinessResult`, `applyCommand(state, command): { state, replies, researchRequested }`, and `validateCandidate(state, candidate): FeasibilityResult`; asynchronous `generateCandidates(state, researchProvider): Promise<TripCandidate[]>` and `answerGuideQuestion(state, question, researchProvider): Promise<{ text, evidence }>` use injected retrieval. B owns deterministic cost allocations and ranking. It never writes SQLite, sends Photon messages or calls a bank.

C exports the repository adapter with `loadTrip(tripId)`, `saveTripIfRevision(state, expectedRevision)`, `recordEvent(eventId)`, `enqueueMessages(messages)`, `recordDelivery(deliveryId, providerMessageId)` and `getPublicSnapshot(tripId)`. SQLite stores trip revisions, constraint provenance, candidates, citations, approvals, event IDs and the message outbox. Apply updates/events/outbox atomically. Domain rejection leaves state unchanged.

C serializes per-trip commands, deduplicates source events, supplies enrolled identity, calls A's parser and B's domain functions, persists updates/replies, and runs research outside the local transaction. Before saving researched results compare the originating revision with current state; discard outdated results. Mark errors without replacing valid prior data. B's functions operate against typed in-memory fixtures while C's repository can be developed against fake domain functions.

Public snapshot includes participants' display names, selected date, itinerary, approved costs, evidence links, revision/status, approvals and optional funding progress. Private budget caps, personal calendars, tokens and raw private messages are excluded. Private answers are visible only to their actor. Local-only web access is the demo boundary; public deployment needs authentication.

Domain rejection codes: `UNKNOWN_MEMBER`, `INVALID_CONSTRAINT`, `AMBIGUOUS_ACTION`, `STALE_REVISION`, `NOT_READY`, `INFEASIBLE_PLAN`, `MISSING_APPROVAL`, `RESEARCH_UNAVAILABLE`. No undocumented silent fallback from live research to fixture facts. Error copy names what is missing or unverified and offers manual input/retry where appropriate.

## Three parallel agents

| Worker | Exclusive ownership | Primary deliverables |
| --- | --- | --- |
| A — Conversation and availability | `src/conversation/**`, `src/availability/**`, matching tests, `docs/conversation.md` | Spectrum, Gemini intent parsing, context gathering UX, guided replies/reactions, private limits, manual dates; optional calendar adapter |
| B — Planning and research | `src/planning/**`, `src/research/**`, matching tests, `docs/research.md` | Readiness, constraint validation, per-person budget feasibility, grounded research, community evidence, candidates, revisions and contextual guide answers |
| C — App and demo | `src/app/**`, `src/contracts/**`, `src/storage/**`, `src/funding/**`, `web/**`, `scripts/**`, shared fixtures, root config/docs | Contracts, enrollment, SQLite/outbox, composition, read-only page, integration and demo; optional funding only after core works |

Use mocks immediately. Root manifests/lockfiles/types are C-only. A/B communicate dependency or interface requests and continue independent work. B has the largest reasoning/data burden; A has transport/identity/calendar; C has integration/state/UI. Optional funding is deferred rather than delaying C's core integration. Early finishers can review or accept an explicit ownership handoff.

Avoid concurrent branch switches in a shared checkout, peer-file edits, broad staging/resets or dependency lockfile collisions. With separate worktrees, C integrates reviewed commits. No worker waits for a live API to run local tests.

## Acceptance fixture and tests

Fixture: Mason, Alex and Jordan; all-in caps 20,000/25,000/30,000 cents; equal split; one vehicle; two manually confirmed weekend windows; hiking and a town visit. Dates and destinations are synthetic test fixtures until sourced research replaces them. Shared upper costs total 48,000 cents, personal upper food costs 2,000 each, contingency 1,000 each: all-in upper total 19,000 per person. A second option can use shared upper costs 45,000 plus the same personal/contingency amounts: 18,000 per person. No hard limit is exceeded.

Revision: Mason lowers their cap to 18,000. Invalidate prior acceptance; reject the 19,000 option and keep or revise the 18,000 option only if dates and preferences still fit. If no option fits, explain why rather than claiming the sum of caps permits the expensive trip.

Required checks:
- A: three different actors update their own constraints; tentative wording asks clarification; wrong-target/stale reaction cannot approve; private cap absent from group output; missing calendars retain manual path.
- B: readiness is false for each missing required slot; conflicting dates produce a targeted question; allocations sum exactly; personal costs and contingency count toward hard caps; unknown essential cost blocks confirmed feasibility; evidence links survive generation; stale research cannot overwrite constraints; guide substitutions explain budget effect.
- C: event replay is idempotent; SQLite restart preserves approved revision and evidence; concurrent updates cannot clobber each other; snapshot excludes private values; live failure is labeled rather than fixture substitution; complete mock demo runs without keys.

Startup: one lightweight TypeScript/Node process and SQLite by default; Nest.js is not required. C chooses verified compatible packages and writes install/start/test/build commands and `.env.example`. Explicit `CHAT_MODE`, `RESEARCH_MODE`, `CALENDAR_MODE`, `FUNDING_MODE` select mocks/live integrations. Default mock mode requires no keys. Local web binds to loopback; no credential data in logs/commits. No product dependencies are installed merely by this design document.

## Demo and verification

Demo: three participants discuss limits/interests; bot asks for missing date window; two sourced trip summaries appear in chat and on the plan page; a member changes their budget; bot explains the revision; all members accept the new version; ask a contextual guide question. Optional ending shows contribution requests and confirmed simulated funds if implemented. Do not spend demo time on an incomplete card/booking feature.

Verify unit/type/build checks, mock end-to-end story, live Spectrum group/DM/reaction, grounded research with actual citation metadata, and optional calendars/banking individually. Record what was tested, with versions and limitations. Mock mode, source estimates and unverified inventory remain visible. A pitch rehearsal is not implementation evidence.

Official references: https://ai.google.dev/gemini-api/docs/google-search; https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query; https://photon.codes/docs/spectrum-ts/messages; https://prod.nessieisreal.com/docs; https://support.reddithelp.com/hc/en-us/articles/360043512931-Don-t-break-the-site. Verify current provider requirements rather than assuming example methods or broad access rights.

## Implementation handoff

This is an architectural design for human review. Building product code follows review of this written specification and an implementation plan. The selected idea does not mean optional integrations, live access or a launch already exist. Preserve any existing code if a repository is supplied; adapt paths to its structure rather than replacing unrelated files. Everything under the ChatGPT project's `sources/` remains read-only.

## Track strategy: maximize meaningful eligibility

Source of event-specific requirements: the user's HackNC 2026 screenshots, transcribed in `research/hacknc-2026/2026-tracks.md` in the original project workspace. That research folder is outside this portable project folder; copy the relevant track notes if needed. Submission deadlines, exact rubric and additional sponsor requirements still require checking against the current event guide. Do not declare eligibility merely because an API key was configured.

| Priority | Track | Product-aligned implementation and eligibility evidence |
| --- | --- | --- |
| Base | General, or Beginner if the team qualifies | Enter one mandatory base track. Beginner requires strictly more than 50% of members to be first-time hackathon participants; for three people, at least two. |
| Core | Photon | A real iMessage agent using Spectrum, receiving messages from multiple participants, delivering group proposals/DMs and handling target-bound reactions. Follow the sponsor's current guidelines. |
| Core | Gemini | Validated multi-person intent understanding and sourced planning/guide responses with a live Gemini integration, rather than a mocked mention. |
| High-value extension | Capital One/Nessie | An approved itinerary becomes exact contribution requests, confirmed simulated transfers into the trip account, and a view of collected/committed/available funds. Demonstrate an approved mock recipient payment if feasible. Banking integration must be meaningful and visibly labeled simulated. |
| High-value extension | Frutiger Aero | A coherent glossy/nature-inspired interface plus an actual nature/sustainability function: source-backed outdoor itinerary options, local park discovery, or verified alternatives that reduce unnecessary driving. Routing comparisons require measured/sourced distances; do not invent emissions savings. A blue/green theme alone is insufficient. |
| Conditional | Community | Explicitly connect the group to local community activities/organizations and make participation easier. Group collaboration or ordinary tourism alone may not demonstrate the track's intended impact. |
| Low overhead, confirm rules | .tech | A useful memorable .tech domain attached to the actual demo if available; verify complete sponsor entry requirements and do not purchase automatically. |
| Post-event/conditional | DEV writing and Commit Fellowship | Write a technically useful project story for DEV; fellowship requires a working team prototype, real problem, opt-in and supplemental form. Do not claim publication/submission without actually doing it. |
| Defer unless intrinsic | ElevenLabs, Solana, Snowflake, Tiger Data | Add only if the user-facing product needs the capability and there is time to implement and demonstrate it. Narrated guidance could justify ElevenLabs; payment chain/data-platform additions are not required for the central experience. Do not pad eligibility with unused APIs. |

Build order is core trip consensus first, then track extensions in small isolated modules. Optional funding work can be handed from C to a worker who has completed their core module, with explicit file ownership transfer. Three workers remain the limit. Prioritize a complete convincing demo over the raw number of entered categories.
