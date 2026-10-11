# Group-chat travel planner — Claude entry point

Read `AGENTS.md` and `docs/travel-product-spec.md` completely before implementation. They are the shared instructions and authoritative design. Copy both instruction files and the docs directory together into the repository root. Do not depend on prior chat context.

## Selected direction

The human selected a group-chat road-trip planner. It gathers multiple people's budgets, availability and preferences, asks targeted questions, researches cited options, gets explicit agreement and adapts to changes. It also supplies community-informed advice tied to the itinerary. The central benefit is removing the organizer's coordination/research work.

The former roommate treasurer direction is superseded. Historical instructions in `docs/archive/` are inactive. Do not start with recurring utilities or make debt carryover the main demo.

Every technology is optional, and meaningful track eligibility is a priority. Nest.js is not mandatory. Proposed core providers are Photon/Spectrum and Gemini. Calendar and Nessie are isolated extensions. Source-backed planning must work without banking or calendar access. No real booking/card/custody claims.

## Assigned roles

- A owns chat, identity/intent normalization, private constraints, reactions and availability adapters.
- B owns readiness, domain transitions, budget feasibility, source retrieval, itinerary generation and contextual guide answers.
- C owns contracts, root tooling, enrollment, persistence/outbox, composition, read-only web page, integration and demo; optional funding follows core.

Exact paths, interfaces, work order, tests and acceptance fixtures are in `AGENTS.md` and the spec. Use your assigned role; no peer edits without an explicit handoff. If no role is assigned, resolve an unclaimed area before editing owned files. Mock neighboring services rather than waiting for their implementations.

## Required sequence

1. Read purpose/core scope, readiness, budget rules and canonical fixture in the spec.
2. Read your owned paths and shared contract. Import common types when C publishes them; temporary local types must match.
3. Follow your role's work order with meaningful failing tests before implementations.
4. Develop against mocks, then add verified live adapters. Report missing access without manufacturing success.
5. Hand C interfaces, files, test results, live verification/limitations and reproduction steps.

## Critical rules

A cap is not a contribution promise. The sum of caps is not an equal-split budget. Include personal expenses and contingency. Unknown essential costs cannot be treated as zero. Preserve sources/provenance and don't call every forum contributor a local.

A plan's revision matters. Reactions bind to exact message/candidate/version; tentative text, majority preference and silence do not authorize personal obligations. Private limits/calendars never leak through public snapshots or logs. Research for old constraints cannot replace newer state.

Only C edits shared types/root manifests/lockfiles. No broad resets, staging peer changes or switching a shared branch. Working APIs are verified independently from passing mocks. Do not silently replace live failures with mock prices/transactions.

## Track strategy

Make the core eligible for General or qualifying Beginner, Photon through Spectrum and Gemini. Consider meaningful trip-funding records for Capital One, and genuine nature/sustainability functionality with Frutiger Aero design. See the full track table in the spec before selecting extras. Do not add unused integrations just to claim eligibility.

## Verification and handoff

The three-person mock story produces two feasible options, handles a lowered cap by rejecting the expensive option, invalidates old acceptance, gathers approval of the new revision and answers a source-linked guide question. Live price/availability remains explicitly checked or unknown.

C documents install/start/test/build/demo commands and runs the integrated story. Each worker reports actual tests and live checks, remaining gaps and reproduction steps. A module passing is not the whole project passing.

This is documentation, not completed implementation. Reading it does not authorize deploying, external submissions, purchasing domains, contacting sponsors, moving real money or launching agents. The original ChatGPT project's synced references under `sources/` remain read-only.
