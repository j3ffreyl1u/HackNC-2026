# Planning and research (Worker B)

Status as of 2026-10-10. Everything here is pure TypeScript with no database, chat or bank imports. B never writes SQLite, sends Photon messages or calls banking.

## What B delivers

| Export | File | Purpose |
| --- | --- | --- |
| `checkReadiness(state, { now? })` | `src/planning/readiness.ts` | Deterministic checklist: `{ ready, missing, conflicts, questions }`. Questions go out one at a time per person, none repeated within 12 hours. Dates, budget and tastes are asked privately, one person each, with no names in the text. `applyCommand` asks once per turn: commands sharing one timestamp (one message) ask once. A not-ready `request_plans` asks the next question, which says what is missing by itself, and a brand-new conversation gets a one-line welcome first. Only when nothing new can be asked does it reply with `describeGaps` (who and what is missing, "your" for the reader, no values), never silence. |
| `applyCommand(state, command, { now? })` | `src/planning/commands.ts` | Domain transitions. Returns `{ state, replies, researchRequested, rejection? }`. |
| `installCandidates(state, researchedAtRevision, candidates)` | `src/planning/commands.ts` | Installs researched candidates; discards results for an older revision (`STALE_REVISION`). |
| `validateCandidate(state, candidate)` | `src/planning/budget.ts` | Hard-limit check: caps, dates, duration, must-dos, drive limit. Returns `{ feasible, violations, unknownEssentials }`. |
| `allocateCosts`, `reprice` | `src/planning/budget.ts` | Exact-cent per-person totals; `reprice` recomputes totals and feasibility against current state. |
| `rankCandidates`, `explainRanking` | `src/planning/rank.ts` | Feasible only; preferences (a member's later preferences add to earlier ones; "no preference" resets them) covered, then lower upper cost, then less driving, then ID. |
| `planContributions(state)` | `src/planning/funding.ts` | For an approved plan at the current revision: each person's whole-dollar share of shared costs plus contingency, rounded up (banks like Nessie store whole dollars). Personal costs stay with the person. Refuses if unapproved, stale, or a shared essential price is unknown. |
| `checkFunding(plan, deposits)` | `src/planning/funding.ts` | Collected against needed from a plain list of deposits. A deposit counts for a person only if its description is `member=<id>;rev=<n>` (`depositTag`) for the current revision; each person must cover their own share. Stale, untagged and pending deposits are kept apart; repeated ids count once. |
| `spendVsPlan(plan, purchases)` | `src/planning/funding.ts` | Spending against the pooled plan by category (`within`, `near` at 80%, `over`), with an `unclassified` bucket instead of guessing a category (`categoryForMerchant`). Read-only: the planner never moves money. |
| `describeFund`, `reminderFor`, `driftNotices` | `src/planning/funding.ts` | The words, each message at most three short lines (chat: "how's the fund?", "remind everyone" and "wrap up the trip" become `request_funding` with `topic` `status`, `remind` or `wrap_up`; the runtime sends reminders privately to each person who owes, the wrap-up to the group, and one spending notice per message): "how's the fund?" (collected, who is still owed, optional spending and a simulated-money note); a private nudge for one person about their own share only; and calm spending notices (near, over, unbudgeted, unclassified) that are given once if the caller passes the keys it already sent. Over-budget notices offer cheaper options and say a plan change needs everyone's agreement. |
| `settleTrip(plan, funding, spend)`, `describeSettlement` | `src/planning/funding.ts` | The wrap-up, calculation only (the bot never moves money): leftover = collected minus spent, returned in whole dollars in proportion to what each person put in (largest-remainder, so refunds add up exactly and strictly larger contributors never get less); an equal, rounded-up split of any shortfall; deposits sent for an older plan revision listed per person to return in full; money naming nobody held apart. |
| Money invariants | `tests/planning/invariants.test.ts` | Seeded randomised tests (300 cases each, reproducible): shares add up to the cent, shared plus personal plus contingency equals the totals, rounding up never leaves the fund short, funding results ignore deposit order and repeated ids, refunds add up exactly, spend classification loses no dollar. |
| `outdoorSummary`, `drivingComparison` | `src/planning/nature.ts` | Nature facts from the plan itself: which stops are outdoor (by tag) and the driving minutes written into each leg. `drivingComparison` compares only options that fit everyone, in minutes, refuses if any drive time is unknown (never zero), and says the drive home is not counted. It claims no emissions or distance savings. |
| `planToIcs(plan, { now? })` | `src/planning/calendar.ts` | The approved plan as a calendar file: one event per stop, times in UTC, text escaped and lines folded per RFC 5545, a stable UID per stop and `SEQUENCE` = revision so a calendar updates stops in place. No money or limits in it; stops without a valid start and end are skipped. Served at `/api/trips/<id>/plan.ics` (only once approved, else 409) and linked from the approval message through `{{CALENDAR_LINK}}` (the line is dropped when no public address is configured). |
| `planTrip(state, provider, { timeZone? })` / `generateCandidates` | `src/planning/generate.ts` | Research, build candidates, return up to two feasible options plus a provisional one, or explain the conflict. Itineraries are scheduled by `src/planning/schedule.ts`. |
| `answerGuideQuestion(state, question, provider, { now? })` | `src/planning/guide.ts` | Cited, plan-relative answers with budget effect. With `options.fund.remainingDollars` it also says whether the option's shared cost is covered by what is left in the trip fund (never drops an option for that, never mentions anyone's limit). Never changes the plan. |
| `ResearchProvider`, `createResearchProvider`, `createFixtureProvider`, `guardLiveProvider` | `src/research/` | Provider interface, fixture provider, validation wrapper for live providers. |
| `createGeminiProvider`, `geminiConfigFromEnv` | `src/research/gemini.ts` | Live Gemini + Google Search grounding provider, with the price pass in `src/research/pricing.ts`. |

Types are provisional in `src/planning/types.ts` and `src/research/types.ts`. Fields marked `PROPOSAL` there are additions C should adopt or replace when `src/contracts/index.ts` publishes trip types (`essential` on `CostItem`, `tags` on itinerary items, `dataSource` on candidates, `roster`, `web` evidence kind, `ApplyResult.rejection`). Contingency is the **total** shared amount, split equally.

**Manual costs are C's.** Group-supplied prices and stop confirmations (`confirm_cost`, `confirm_stop`) are implemented in C's `src/app/planning-adapter.ts` against the published contracts. B had a duplicate `provide_cost` action; it was removed.

## Integration notes for C

1. **Command flow.** Call `applyCommand(state, command, { now })`, pass your own timestamp for determinism (it falls back to the clock). On `rejection`, state is the same object; send the private reply. Save state only if `state !== previous`.
2. **Research flow.** When `researchRequested` is true: read `state.revision`, run `planTrip(state, provider)` **outside** any DB transaction, then reload the trip. Call `installCandidates(current, outcome.revision, outcome.candidates)`; on `STALE_REVISION` drop the result and, if `researchRequested` is still true for the new state, run again. Enqueue `outcome.replies` only if install succeeded.
3. **Material changes restart research.** A confirmed change to a cap, dates, must-do, origin, length, region or car starts a new revision, clears acceptances and re-checks every candidate. If nothing standing is feasible and the trip is ready, `applyCommand` returns `researchRequested: true`.
4. **Guide questions.** `ask_guide` is a no-op in `applyCommand`. Call `answerGuideQuestion` yourself for that action. It is informational and returns `{ text, evidence, mode }`.
5. **Funding.** `request_funding` is refused (`MISSING_APPROVAL`) until the plan is approved, then returns state unchanged. Funding belongs to your adapter.
6. **Public snapshot.** `Violation.memberId` and `overByCents` on budget violations identify who is over their cap. Strip them from the public snapshot and use `publicFeasibilitySummary`. `privateOverage(feasibility, memberId)` is for that member's private message only.
7. **Research mode.** Choose explicitly: `createResearchProvider({ mode: 'mock', fixtures: defaultFixtures })` or `{ mode: 'live', live: createGeminiProvider(config) }`. Live mode with no provider throws `RESEARCH_UNAVAILABLE`; there is no fallback to fixtures. Show `ResearchError.userMessage` and offer manual input or retry.
8. **Search suggestions.** Live results may carry `searchSuggestionsHtml`. B's live provider is experimental (see the correction under "Verified: Google Search Suggestions terms"); C's private research view is the compliant path.
10. **Question fields.** Each `ReadinessQuestion` and `PendingQuestion` now carries `field` (the constraint a reply would set, e.g. `budget`, `availability`), set by `fieldForKey` in `src/planning/questions.ts`. Use `q.field` instead of splitting `key`. It is absent for roster and consent questions.
9. **Env.** `GEMINI_API_KEY` (required for live) and `GEMINI_MODEL` (optional, default `gemini-3.8-flash`). Please add both to `.env.example`. `.env` is already gitignored.

## Behavior that is easy to get wrong

- A stated maximum is a constraint, never a contribution. The sum of caps is never used. Each person's own upper total (shared share + their personal costs + contingency share) must fit their own cap.
- Unknown costs are never zero. An unknown essential price makes a candidate `feasible: false` with no violations (provisional), so it cannot be selected or approved.
- A tentative statement does not count. Restating the same value is not a change. Preference changes re-rank but do not void a plan.
- Selecting an option is not accepting it. Approval needs every consenting participant to accept the exact candidate at the current revision.
- Public replies never contain a cap, an overage amount or who is over. Private amounts go only to that person.
- Research requests contain places, dates and interests only. No money, names or calendars.
- Retrieved text is data. It is sanitized (control and invisible characters removed, length bounded) at the provider and again before display.

## Verification

Run from the repository root:

```bash
npx tsc --noEmit -p tsconfig.b-check.json     # typecheck B's files
npx vitest run tests/planning tests/research    # B's tests
```

Last run (2026-10-10): typecheck clean; 348 tests passed, 1 skipped (the live test, which needs a key). Mutation checks (deliberately breaking a rule and confirming tests fail) were run for readiness, budget caps and contingency, revision invalidation, feasibility filtering, per-person cost expansion, stale-revision checks, provider failure handling, result validation, guide cap exclusion, display-time sanitizing and Gemini price handling.

Acceptance fixture (caps $200/$250/$300; shared upper costs $480 and $450; $20 food and $10 contingency each): the options total $190 and $180 per person with no cap exceeded. Lowering Mason's cap to $180 drops the $190 option, clears acceptances and moves to revision 2. The $180 option stays and needs fresh acceptance from all three.

### Live verification (Gemini)

| Check | Result |
| --- | --- |
| Plain `POST /v1beta/interactions` with `gemini-3.8-flash` | Verified 2026-10-10: HTTP 200. |
| Same request with the `google_search` tool, free-tier key | HTTP 429 quota. Google's pricing page lists Search grounding as not available on the free tier. |
| Same request after the project got billing credit | Verified 2026-10-10: HTTP 200, grounded answer with `url_citation` annotations. |
| Smoke test `tests/research/gemini.live.test.ts` | Passed 2026-10-10: 4 options, 7 sources, about 6.6 s. |
| Parser against a real captured response | `tests/research/captured/gemini-interaction.json` (signatures and usage removed). |

Reproduce the live check (reads `GEMINI_API_KEY`; one read-only request):

```bash
set -a; source .env; set +a; npx vitest run tests/research/gemini.live.test.ts
```

`source` fails if `.env` has lines that are not plain `NAME=value`. Without a key the test skips, and a skipped run proves nothing.

Cost: a first unconstrained call ran 16 searches and about 173k prompt tokens (49 s, roughly 13 cents). With the prompt limited to 4 searches and `thinking_level: low`, a call is about 6 s and 16k tokens (about 1 to 2 cents). Search queries are billed per query after 5,000 free per month.

### Live price pass

After finding options, the Gemini provider prices the first 3 with four narrow lookups each (`src/research/pricing.ts`), because one broad question returns mostly `unknown`. It runs only for plan requests that carry `nights` and `groupSize` (`planTrip` sets both) and can be switched off with `priceLookups: false`.

| Cost | Lookup | Computed in code |
| --- | --- | --- |
| Lodging (shared) | up to 3 named places with a stated nightly rate and how many they sleep | rooms for the group × nights; low = cheapest place, high = dearest place + 15% for taxes and fees |
| Fuel (shared) | one-way miles and current gas price | round trip at 30 to 20 mpg, high + 25% for driving around; parking and tolls not included |
| Admissions (per person) | adult admission for each stop | sum over stops; one stop with no sourced price makes the whole figure unknown |
| Food (per person) | main-course price at up to 3 named restaurants | 2 restaurant meals a day over nights + 1 days, high + 25% for drinks, tax and tip; groceries not included |

Only lines a citation covers are used. Everything else stays `unknown`, never zero. Every assumption is written into the option's tradeoffs, so it appears in the chat message. An option with no price at all is not proposed; the group is told. A failed lookup leaves that price unknown and is listed in the limitations.

Live check, 2026-10-10 (three-person fixture trip, 2 nights, 3 people): a full plan took 24 s and about 13 requests. Four options came back; lodging, fuel and food were priced with citations; admissions and some fuel lines were often missing. Real totals were roughly $300 to $500 per person on the upper estimate, so the synthetic $200/$250/$300 caps correctly rejected them. For a live demo, use caps that match real prices. Each plan uses roughly 40 search queries; at 5,000 free per month that is about 125 plans.

### Findings from live responses

- Citation links are Google redirect URLs (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`). The real site is only in the citation `title` (a domain), which is what source classification uses.
- Citations cover parts of each line, not every field. A price counts as an estimate only if a citation covers that field; otherwise it is unknown.
- Asked for a whole option's costs in one answer, the model returned `unknown` for every price and for visit lengths, which is why the price pass above exists. Stops with an unknown length are planned at 2 hours and flagged as an assumption.

### Verified: Google Search Suggestions terms

Read directly from https://ai.google.dev/gemini-api/terms, 2026-10-10 (the earlier attempt to fetch the `#grounding-with-google-search` anchor had failed to surface this text). Whoever renders a grounded answer in chat or on the web page (likely A, since B only passes `searchSuggestionsHtml` through) must follow these:

- Grounded Results may be shown only to the end user who submitted the prompt, together with their associated Search Suggestion(s).
- The Grounded Result and Search Suggestions must not be modified, and no other content may be interspersed with them, without Google's written permission.
- No interstitial content may be placed between a Search Suggestion/Link and its destination page, and end users may not be redirected away from or otherwise blocked from the destination page.
- When a Grounded Result is resubmitted for refinement, its associated Search Suggestions/Links must still be shown with the final result.
- A click on a Search Suggestion is governed by Google's own Terms of Service once the user reaches google.com; no click-through is required of us.
- Interactions with the interface may be monitored, but not tied specifically to a given Search Suggestion or Grounded Result.
- No specific attribution wording is required for Search Suggestions themselves (the terms only note that applicable law may separately require attributing AI-generated content).

**Correction (2026-10-10), after reviewing C's integration branch.** An earlier version of this section called this a rendering constraint for the chat layer only. That was too narrow. The terms say not to modify grounded results or mix other content into them, and to show them to the user who asked. B's live price pass extracts numbers from grounded text, stores them in the plan and shows them to the whole group, which does not fit a strict reading. C's live path avoids this: `createLivePlanner` in `src/app/live-research.ts` builds a manual cost worksheet with every price unknown and shows the grounded answer, with its search suggestions, only to the person who asked. So B's Gemini provider (`src/research/gemini.ts`) and price pass (`src/research/pricing.ts`) are **experimental and not used by the integrated app in live mode**; the fixture provider is what the app uses for mock mode. Keep them for development and testing only unless someone obtains Google's written permission or restructures the use. This is not legal advice.

## Not verified, or open

- **Live prices (experimental, not used by the app; see the correction above) are estimates with gaps.** See "Live price pass" above. A live option is approvable only if every essential cost was found with a citation and fits every cap; admissions are often not found, which keeps an option provisional. C's `confirm_cost` lets the group fill gaps.
- **Citation offsets for non-ASCII text: verified live (2026-10-10).** A grounded answer in accented French (`tests/research/captured/gemini-nonascii.json`) had citation offsets running to 461 against 443 characters and 462 bytes, so they are UTF-8 byte offsets, which is what `toCharOffsets` assumes. Covered by `tests/research/gemini.nonascii.test.ts`.
- **Redirect link lifetime: partly checked.** Links captured about an hour earlier still returned a 302 to the real page, with the target matching the citation's title. How long they last beyond that is unknown; checking again later (a day or more) is the only way to find out.
- **Live response with an actual forum/community hit.** The forum-host classification and the prompt wording asking for traveler discussion content (`src/research/grounding.ts`, `src/research/gemini.ts`) are built and unit-tested against synthetic data only; no live response so far has actually returned a forum URL to classify.
- **Itinerary times** are laid out on real days (`src/planning/schedule.ts`): stops start no earlier than 9:00 and finish by 20:00 local time, a stop that would run late moves to the next morning, and a stop longer than a day or that cannot finish before the trip ends is left out with the reason shown. Visit lengths for live results are partly assumed (see above). Travel between stops is taken as given; real routing and opening hours are not checked.
- **Timezone.** The shared contracts have no trip timezone, so `planTrip(state, provider, { timeZone })` defaults to `America/New_York` (fits an NC road trip). C should add a timezone to the trip and pass it in. The trip start is the start of the first common window, so a window that starts at midnight starts the trip at midnight.
- **Community research.** A standalone Reddit API integration was attempted and dropped: new Reddit Data API (script-app) access now appears to require a moderation use case, which this isn't, and the account-creation flow silently refuses apps that don't qualify. Instead, Gemini's Google Search grounding is prompted to surface forum/discussion content (Reddit, TripAdvisor forums, Quora, and similar; see `FORUM_HOSTS` in `src/research/grounding.ts`) and labels it `community`, attributed as one traveler's experience. This has not been checked against a live response that actually contains a forum hit. Contributors are never called locals.
- **Nature and sustainability research** for aligned tracks is not built.
- **Availability** is not checked for any option, live or fixture. All outputs say so.
- Nothing here claims a booking, a guaranteed price or real inventory.
