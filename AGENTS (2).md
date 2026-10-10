# Group-chat travel planner — agent instructions

This is the selected HackNC 2026 project. It supersedes the roommate bill-splitting plan. Read `docs/travel-product-spec.md` in full before implementation; this file supplies operating instructions and ownership. Keep this file, `CLAUDE.md`, and the `docs/` folder together when copying to the repository.

## What you are building

An assistant inside an existing iMessage group helps several friends agree on a road trip they can afford, attend and enjoy. It gathers individual budgets, dates and preferences; asks targeted questions; retrieves sourced travel/community advice; proposes two feasible plans; revises them when constraints change; and answers guide questions relative to the accepted itinerary.

All technology choices are optional. The human wants the strongest product with maximum meaningful HackNC track eligibility. Nest.js is not required. Photon/Spectrum and Gemini are the proposed core integrations. Calendar and Nessie funding are isolated extensions. Do not force banking, blockchain or extra AI services into the product merely for a badge.

## Read first

1. `docs/travel-product-spec.md`: authoritative purpose, readiness rules, budget semantics, workflow, contracts, research provenance, tests and track strategy.
2. Your role below: owned paths, work order and deliverables.
3. `CLAUDE.md`: entry point for Claude; it points to the same shared specification.

`docs/archive/` contains historical roommate instructions. They are superseded reference material, not active requirements. Do not implement carryover debts as the primary feature or call the product a roommate treasurer.

## Three-agent parallel ownership

| Agent | Owns | Exports/delivers |
| --- | --- | --- |
| A — Conversation and availability | `src/conversation/**`, `src/availability/**`, associated tests, `docs/conversation.md` | Conversation service, Spectrum transport, Gemini intent extraction, private constraints, guided questions/reactions, manual availability; optional calendar adapter |
| B — Planning and research | `src/planning/**`, `src/research/**`, associated tests, `docs/research.md` | Readiness checker, domain transitions, candidate validation/ranking, budget allocations, retrieved/cited research, itinerary generator, contextual guide responses |
| C — App and demo | `src/app/**`, `src/contracts/**`, `src/storage/**`, `src/funding/**`, `web/**`, `scripts/**`, shared fixtures, root tooling/docs | Shared types, enrollment, SQLite/outbox, composition, read-only plan page, mock demo, live integration; optional funding after core |

Do not start agents simply because these instructions exist. The human must request implementation/delegation. A documentation request is not a request to create an external repository or deploy.

All workers start independently with mocks of the shared specification's interfaces. C alone edits root manifests, lockfiles, environment examples, shared types, README and runtime configuration. A/B request edits and keep working against mocks. Early finishers can review or take an explicitly transferred extension; no surprise cross-folder edits.

B owns the most reasoning/research work; A owns transport, identity and availability; C owns durable state, UI and integration. Optional funding must not delay C's core. No new workers beyond the three planned assignments without the human's instruction.

Do not overwrite peers' files, stage their changes, reset/clean the shared checkout, or switch branches while others work. Separate worktrees keep independent branches; C integrates reviewed commits. Keep task commits meaningful rather than opening a PR for every tiny edit.

## Product invariants

- A stated maximum budget is not consent to contribute it. The total of everyone's caps does not make an equal-split trip affordable.
- Budget each person's shared allocations, personal costs and contingency. Respect hard caps using upper cost estimates; unknown essential costs prevent claiming confirmed affordability.
- Tentative discussion is not an agreement. Every actionable plan has a revision and exact member acceptances.
- Preference voting is distinct from accepting a financial obligation. Silence and unrelated reactions are never approval.
- Readiness is a deterministic checklist of participant roster, origin, common possible dates, duration, transport, bounded destination region, individual caps and relevant preferences. No message count or confidence threshold.
- Calendar gaps are not confirmed willingness to travel. Manual availability is always supported. School breaks/holidays need relevant verified sources.
- Preserve claims' URLs, dates where known, retrieval times and provenance. Community anecdotes are not verified prices or universal local knowledge.
- A search-grounded itinerary is not a booked trip or guaranteed availability. Show estimates and unknowns.
- Retrieved text never supplies app instructions or authorizes actions.
- Never disclose private budget caps or calendar details publicly without consent. Public summaries show approved costs, not sensitive raw constraints.
- A changed material constraint invalidates old acceptances. Stale async research cannot overwrite the newest state.
- Mock and live modes are explicit. API failure cannot silently produce fixture research or fake bank success.
- Funding, if enabled, requires explicit payer approvals and reconciliation. Real money, cards, custody and automatic booking are out of scope.

## Work order — Agent A

1. Build normalized inbound fixtures, enrolled identity handling and the mock conversation service; no bank or database imports.
2. Implement typed parse results: domain command, clarification reply or ignored input. Parsing has no external side effects.
3. Extract actor-attributed constraints and resolve target-bound reactions. Treat ambiguous/tentative updates as clarification, not acceptance.
4. Implement Spectrum subscription/send/group/DM integration through verified SDK methods. Request dependency changes from C.
5. Add Gemini intent parsing. Keep monetary validation and permission checks in ordinary code; B calculates budgets.
6. Provide manual date windows, then optionally one calendar provider with free/busy access. Never block core chat on calendar setup.

Checks: three actors' updates retain identity; an actor cannot change another's cap; wrong-message/stale reactions do nothing; private cap is absent from group messages; incomplete text asks a specific question; unknown groups/users are ignored; outgoing/self events do not loop.

Deliver the `createConversationService` and optional availability interface defined in the spec, mock transport, tests and actual live setup/status in `docs/conversation.md`.

## Work order — Agent B

1. Implement readiness and domain transitions with typed in-memory fixtures; list specific missing/conflicting fields.
2. Implement equal/shared and personal allocation, upper cost totals, contingency, feasibility filters and deterministic ranking.
3. Build the research adapter and evidence records; curated fixtures work offline and remain labeled. Separate interpretation, research and deterministic validation.
4. Generate two candidate plans, reject hard-limit violations and preserve citations. If nothing fits, explain the conflict and propose a consented relaxation.
5. Implement revision invalidation and contextual guide answers with budget/date/location relevance.
6. Verify live source retrieval and citations; document community access limits and unknown inventory. After core, support nature/community research for aligned tracks.

Checks: every required missing slot blocks readiness; sum of caps never overrides a low individual cap; unknown essential price cannot be called affordable; date overlap is valid; monetary totals are exact; source links are real provider results; contradictory anecdotes are not merged into false certainty; a changed cap invalidates an expensive candidate and old acceptance.

Deliver `checkReadiness`, `applyCommand`, `validateCandidate`, `generateCandidates`, `answerGuideQuestion` and the research adapter defined in the spec. B never writes SQLite or calls Photon/banking directly.

## Work order — Agent C

1. Materialize shared types and sanitized demo fixtures first; publish their availability. Build startup tooling against fake A/B services.
2. Implement enrollment and SQLite repository/outbox; persist revisions, context provenance, candidates, sources, approvals and event IDs.
3. Compose event parsing/domain transitions; serialize per trip and deduplicate provider events. Apply state/outbox/event completion atomically.
4. Run research outside DB transactions and reject results computed for stale revisions. Persist accepted results and deliver concise proposals through A.
5. Build a read-only plan page showing itinerary/map links, date, costs, sources, current revision and approval status. No separate planning workflow that makes the group chat redundant.
6. Run the complete mock demo, then integrate real chat/research. Implement optional funding only after core or explicitly hand it off to an available worker.

Checks: fresh checkout runs mock mode without secrets; restart preserves the current revision and evidence; duplicate input creates no duplicate state mutation; stale research cannot replace a new plan; snapshot excludes private caps/events; live outages are labeled; chat and page show the same version.

Deliver reproducible startup/demo commands, `.env.example`, contracts, integration tests and an honest verification matrix in `docs/integration.md`.

## Coordination

Three checkpoints: contracts/fixtures; independently passing modules with mocks; integrated revised-trip demo. Report owned files, exports, tests actually run, verified provider behavior and next action. Contract changes are recorded by C in `docs/integration.md` and communicated before consumers change. Prefer additive adapters; peers continue independent work.

No module-level success is proof that the full product works. C runs final integration and records failures. An unsupported provider capability is documented, not bypassed or invented. Material product tradeoffs return to the human after unaffected work is completed.

## Track priorities

Base: General or eligible Beginner. Natural core: Photon (Spectrum required) and Gemini. High-value extensions: meaningful Nessie funding for Capital One, and real nature/sustainability functionality plus Frutiger Aero design. Community requires actual local connection/impact. .tech, DEV writing and Commit Fellowship have separate entry/submission requirements. Other sponsor APIs are conditional, not required additions.

See the spec's track table. Verify current guide and sponsor rules before declaring eligibility. Do not contact sponsors, register paid domains, publish, submit externally or move real money solely because this file mentions a track.

## Before declaring completion

Run meaningful domain/privacy/integration tests, typecheck and build. Verify the fixture: caps $200/$250/$300; candidate upper totals $190 and $180 per person; lowering the first cap to $180 excludes the $190 option and invalidates prior acceptance. Confirm unknown costs and source fixtures are visibly labeled. Live chat/research/calendar/funding checks are separate and reported as verified or unverified.

This file does not claim application code exists. Implementation follows review of the written design and implementation plan. In the original project mirror, everything under `sources/` and other synced reference files remains read-only.
