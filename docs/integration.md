# C integration status - 2026-10-10

C composes A from origin/Jeffrey-agent/spectrum-loop and B from origin/Mason-planning/research. Their owned source/test files were imported without switching branches, overwriting existing peer paths, staging changes or changing the legacy finance module.

## Contracts

C's serialized contracts remain readable. planning-adapter.ts converts B's provisional types; conversation-adapter.ts converts A's date-only windows, parser results and delivery receipts. B retains its provisional planning declarations; A now re-exports C-owned shared conversation types. Adopted fields include CostItem.essential, itinerary tags/label, candidate dataSource, state roster, evidence kind web and ApplyResult.rejection. Nested values and cost categories are explicitly adapted; B contingency is the total shared amount. Dates use the trip timezone and inclusive date windows respect DST.

State adds timeZone, private pending budget confirmations and private cost-confirmation provenance. New TripAction confirm_cost carries candidate ID, exact revision, cost ID, safe integer low/high cents and source message ID. Consenting members can confirm shared costs or their own personal costs. The result is labeled an estimate, records actor/source/time, reprices through B, creates a revision, clears selection and all acceptances, and announces the new version. Syntax: confirm cost CANDIDATE vREVISION COST_ID $LOW-$HIGH. A/B can adopt the additive action through their own adapters; C handles it explicitly without editing peer files.

## Composition and durability

The runtime serializes inbound events, binds actor/trip identity itself, deduplicates provider event IDs and commits domain changes, replies and event completion atomically. B gets the inbound timestamp. Multi-command messages preserve material revision changes instead of collapsing them into an invented revision. Unchanged JSON is not rewritten. Pending budget confirmations persist atomically and are supplied only to their actor.

Research runs outside SQLite transactions, reloads state, installs through B's installCandidates and enqueues outcome replies only after successful installation. Stale work is discarded and pending current research is scheduled; startup resumes researching trips. The outbox retries every five seconds and stores all receipts. Selection versus acceptance is saved with each proposal binding: an old selection reaction cannot later count as acceptance. Legacy bindings without an action kind cannot authorize reactions. Delivery is at least once; provider success followed by failed receipt persistence can cause resending.

Public snapshots omit constraints, pending confirmations and cost provenance. Budget violations lose member identity and amounts, including on the selected candidate, and get generic public feasibility wording. Private overages are delivered only to that member. Chat and page use the same persisted revision and approvals.

## Adapted live research

The user chose to adapt live grounding. Google's current [grounding terms](https://ai.google.dev/gemini-api/terms#grounding-with-google-search) require associated suggestions and restrict storing/reworking grounded results; the [response documentation](https://ai.google.dev/gemini-api/docs/google-search) describes the original answer and search_suggestions HTML.

C startup does not feed B's programmatically extracted Google prices into the database or group messages. LiveResearchDisplay stores only an expiring request, calls Gemini on an explicit local-page POST, displays the original answer and original suggestions together once, consumes the request token and retains no provider output. The page uses no-store, disables scripts/framing/tracking and sends no referrer. Only the requesting member receives the bearer link. Provider errors or missing suggestions fail explicitly; no fixture fallback occurs. The display boundary is implemented and tested, not a legal certification.

Automatic prompts contain agreed origin/region/duration, without caps, member names, private calendars or raw chat history. Live guide requests include the actor's question and return a private link. Results can be opened only on the agent machine; authenticated remote hosting remains out of scope.

Live planning saves a manual worksheet derived exclusively from participant constraints, with an agreed-region itinerary placeholder and six essential unknown categories including parking/tolls and contingency. Explicit participant confirmations provide estimates. A worksheet without a confirmed stop cannot be selected or accepted even after every price is confirmed. `TripAction.confirm_stop` adds a participant-confirmed stop with timezone-qualified times and requirement tags, rejects overlap/out-of-trip/stale inputs, records private actor/source/time provenance, advances the revision and clears acceptance. Transport/activity prices need reconfirmation for the changed itinerary. Syntax: `confirm stop CANDIDATE vREVISION LOCATION | START_ISO | END_ISO | tags`. Automatic priced live proposals remain future work; must-do checks still block uncovered requirements. B's original grounded provider remains available in its own module/tests but C startup uses the adapted display path.

## Actual verification

Typecheck: passed. Build: passed. Travel-module suites: 462 passed, one live test skipped. The integrated mock test uses actual A normalization/parsing, B planning and SQLite/outbox. It verifies three actors, targeted questions, $190/$180 options, a $180 cap update, invalidated old acceptance, fresh three-person approval, a contextual sourced guide, restart persistence and public privacy. A C fixture adds a free indoor alternative that fits the exact cap.

Additional tests cover stale/unknown cost confirmation, DST, original answer/suggestion rendering, single-use requests, missing-suggestion rejection and full manual worksheet repricing. Existing tests cover replay, spoofed actor identity, stale research and provider delivery bindings.

Actual Spectrum group/DM/reactions and C's adapted Gemini display have not been exercised against credentials. B's reported live test is teammate evidence, not a C live verification. Live calendar/funding remain disabled.

Full npm test also exposes an existing Windows EBUSY cleanup failure in tests/finance/store.test.ts: the future-schema rejection leaves a database handle open. C does not own that module and did not edit it. The scoped travel suites pass.

Commands and setup are in README. npm run demo:chat uses a separate SQLite database and no secrets; npm run dev starts the composed chat agent plus its read-only plan viewer.

## A/C contract checkpoint

C published the conversation shapes under src/contracts/conversation.ts, exported through src/contracts/index.ts. src/conversation/contracts-local.ts now contains only re-exports. No shape change is requested from A. Chat-specific aliases distinguish A's date-only/primitive intent values from C/B's persisted nested values; C's boundary adapter performs conversion.

Two additions to the original specification are adopted:
- ChatParseResult (re-exported by A as ParseResult) supports `{ kind: 'commands', commands, clarification?, expects? }` for several facts from one provider message. C applies every command in order and commits the resulting state, event and replies atomically. `clarification` is an OutboundMessage and `expects` carries a pending budget confirmation.
- Shared SendResult has `providerMessageId`, `deliveries: Array<{ memberId, providerMessageId }>` and optional failedMemberIds. C records every distinct receipt, including every deliveries[].providerMessageId, against the proposal. Group transport's top-level ID is also preserved. A receipt failure leaves the outbox pending.

For every parse C constructs context for that member alone: actionable plans and exact revisions; targetProposal from the reacted-to provider ID with selection/acceptance kind; latest applicable group/private pendingQuestion; and pendingConfirmation persisted from that member's last reply expects. Private questions/confirmations belonging to another member are excluded.

Spectrum is pinned at spectrum-ts@12.10.1 and dynamically loaded only for CHAT_MODE=photon. Canonical environment names are SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, GEMINI_API_KEY and optional GEMINI_MODEL. Existing startup scripts run Node with --env-file=.env. Local .env was not edited.

Live enrollment now accepts any nonempty fixed participant phone list in config, with unique E.164 providerUserId values, internal IDs, display names and consentedAt timestamps. No dynamic group join changes enrollment. Live state starts gathering with no synthetic budgets or dates; chat supplies those facts. Unknown senders/groups remain ignored.



## Jeffrey handoff update

Reviewed A commit 0f2d108. Shared conversation ConstraintValue now preserves region maxTravelMinutes?: number and transport vehicleAvailable?: boolean. C respects explicit false vehicle availability and carries optional drive limits without inventing a four-hour bound. The commands ParseResult (clarification and expects included) and per-delivery SendResult retain A's shapes. A Mac user can copy src/conversation/contracts-local.ts from the published handoff; PowerShell is not required. Apply C's 7e46cc6 and the follow-up contract fix to A's current branch; the intermediate module-snapshot commit is unnecessary when A/B are already integrated.

## Mason review fixes and canonical decision

C handles the contract edits directly. Canonical TripCommand/ConstraintUpdate values are A's flat shapes: number budgets/duration, string origin/region/transport, list preferences/must-dos, and instant availability intervals. Region keeps optional maxTravelMinutes alongside its text; transport keeps optional vehicleAvailable alongside its text. Missing vehicle evidence stays undefined (except established own_vehicle/no_vehicle sentinels); B rejects unresolved vehicle access rather than accepting a guessed boolean. B conversion happens only in the planning adapter. Existing SQLite record shapes are named StoredConstraintValueByField/StoredConstraintUpdate and remain a separate persistence format. A's raw extraction contract retains inclusive date windows for compatibility; the boundary converts them using the trip timezone, including DST. Already-normalized intervals pass through unchanged, so Jeffrey can move normalization into A without double conversion.

GroupConstraintRecord now requires memberId; the planning adapter no longer assigns roster[0] to unidentified records. New fixtures supply their explicit fixture author. Legacy anonymous group records require author metadata migration and fail explicitly rather than hiding conflicts. Conflicting origins retain both authors in the integration regression test.

confirm_cost no longer creates evidence with an empty URL. It clears superseded evidence references for that price and relies on private costConfirmations for actor/source/time provenance. Provider evidence records remain unchanged. Grounded output remains private and ephemeral; B live price extraction is not part of app startup.

LiveResearchDisplay sends generation_config.thinking_level=low and asks for at most four searches. The search count is a prompt instruction, not a provider-enforced quota; C has not remeasured live latency. Question-field mapping is deliberately unchanged until Mason publishes the explicit field. This review item remains pending B's handoff.

## Combined-build follow-up

B at e36d794 (including 7955e65) was overlaid locally for verification only. Do not cherry-pick stale source snapshots into Jeffrey's combined branch; merge Mason's branch directly before applying C's follow-up. A's 0f2d108 parser was likewise used locally for checks. The reported f30205c / integration/combined-v2 has not appeared on origin as of this fetch, so C cannot independently claim verification of that SHA.

PendingQuestion.field is optional. fromState uses the explicit q.field without deriving it from a key; roster/consent questions remain fieldless. The actor context omits pendingQuestion when no actual constraint field exists. C intercepts confirm cost and confirm stop text in its conversation wrapper before A's parser; B provide_cost is unnecessary and is absent from the updated B branch.

Legacy saved group constraints missing an author still stop planning safely, but runtime now catches the error, preserves the original trip, atomically records the event and sends only the actor an operator/migration explanation. It does not guess an author or automatically reset a trip.

Direct topology is supported through enrollment mode: direct, persisted in SQLite and passed to A for DM fan-out. Existing enrollment rows migrate to group mode. Changing topology requires a distinct enrollment/database. Every DM receipt remains bound to its proposal; real sends remain coordinated by Jeffrey. No live message or Gemini request was made during this follow-up.

The corrected cap preset is $520/$560/$600, then Mason lowers to $450. tests/fixtures/realistic-demo.json and C's separate realistic research fixtures exercise synthetic $328/$500 upper totals: both fit initially; the $500 option and old acceptance are dropped after the update; the $328 option is approved anew. This does not verify actual live prices or unknown essential costs. The original $200/$250/$300 -> $180 acceptance fixture is retained. Run npm run demo:chat -- --realistic-caps using a fresh DATABASE_PATH to replay.

Google display restrictions are handled by C's original private, ephemeral view. Citation lifetime and non-ASCII extraction in B remain Mason's experimental-provider checks; C does not use B price extraction in the production live path. Live Spectrum combined-flow tests, group delivery and post-cap live latency remain unverified, pending Jeffrey's coordinated run.

## Published combined branch verification

origin/integration/combined-v2 is now available at e18a28a. Its src/planning and src/research match Mason e36d794 exactly (read-only git diff reports no paths). C's follow-up was tested locally against that branch's updated A boundary and Mason's current modules: 488 travel tests passed, one live test skipped; typecheck and build passed. The A/B overlays remain local and are excluded from C's follow-up commit. Jeffrey should cherry-pick C's follow-up onto e18a28a and handle the sole fast-forward of shared main.

The new availability boundary emits real intervals; C passes them through unchanged. The agreed cap preset is $520/$560/$600 -> $450 with synthetic $328/$500 options. This verifies the budget/revision story rather than establishing live quotes. No live test message or research request was sent. Shared main was not merged or pushed by C.

## First live DM feedback: C follow-up

Readiness questions are now deferred during per-command application and selected once at the end of the inbound event. The final pass uses B's deterministic topic selection and two-question limit. Deferred questions are not saved as asked, so their cooldown does not suppress a question that was never delivered. An A clarification takes priority and suppresses extra readiness questions for that event. Material transitions, rejection replies and proposals remain separate from readiness questions.

Explicit request_plans with NOT_READY receives a private, actor-facing summary of missing/conflicting fields even when prior questions are on cooldown. It names missing member slots without exposing caps or calendar details. The standard readiness questions use the proposed casual wording. The roster message asks the organizer to add missing participants rather than claiming the bot can dynamically enroll someone who texts it.

A runtime regression covers two commands in one message, only two stored/delivered readiness questions and a repeated request during cooldown. Jeffrey's 961d0c4 parser/acknowledgement changes were not available on origin during this fetch; he should push/integrate them on A's side and verify that show us some options reaches request_plans. No live test messages were sent by C.

## C's assigned live DM follow-up

A new regression sends origin, nights, vehicle, region, budget, availability and preferences in one inbound event. All facts persist for the actor and none of those answered group facts are re-asked; only final-state gaps are considered. C's f6182a9 turn-finalization fix remains the runtime solution, not simply dropping the first replies after saving their cooldowns.

Live startup now warns if fewer than two participants are enrolled. Enrollment is fixed and cannot be expanded by an arbitrary person texting the bot. The organizer-facing roster copy remains accurate rather than promising automatic additions.

`npm run diagnose:trip -- --trip TRIP_ID [--event EVENT_ID]` is a read-only SQLite diagnostic. It prints budget/date record presence and certainty per internal member ID without values, dates, phone numbers or message text, and optionally whether an event was recorded. Missing Mason records cannot be diagnosed as data loss without confirmation that the messages were sent, received, attributed and parsed. Jeffrey should run it against the actual live database and compare his local provider/parse evidence; C has not accessed that database or sent any live messages.

Mason owns planner-level readiness summaries/copy and preference merge semantics; his pending message-turn fixes should be checked with C's deferQuestions/finalizeTurn adapter before the next integration. No planner or conversation source snapshots are included in C's follow-up.

## Readiness ownership after Mason's live DM fixes

Supersedes the private NOT_READY summary and question-copy behavior described above. C now passes B's readiness replies and wording through unchanged. The duplicate missingSummary reply and its text filter, plus warmQuestion, have been removed. Integrate Mason's latest always-answer and friendly-copy commits together with this change; the older local B snapshot does not provide that behavior.

C retains deferQuestions/finalizeTurn: intermediate questions are withheld without recording them as asked, and only final-state questions are recorded and delivered once per inbound message. Mason reviewed that behavior against his cooldown rules. Fixed enrollment and the startup warning for fewer than two participants remain in C. The planner's invitation wording does not dynamically enroll anyone; the organizer still has to update the configured roster.

No live messages or research calls were sent for this cleanup. Combined verification and the next live DM test remain coordinated by Jeffrey.

## C trip-fund integration

C added a GET-only Nessie reader, separate preview/execute sandbox simulator, revision-bound fund service and aggregate web fund panel. See docs/funding.md for exports, configuration and the private chat boundary. This requires Mason's src/planning/funding.ts from his latest branch; its local verification copy is excluded from C's commit. Funding readings do not mutate saved trip state; the fund endpoint returns the current calculated status. All labels distinguish sandbox/local simulation from real money. No live Nessie writes or Photon messages were sent by C.

## Final C funding/nature handoff checks

Typecheck and build passed; 36 targeted tests passed (funding reader/service/simulator/guide/runtime plus HTTP/config/live-display fixtures). The funding runtime regression reopens SQLite and verifies a persisted near-budget notice is not re-enqueued. No live write, bank request or Photon listener was run. docs/devpost-draft.md contains submission copy and a two-minute storyboard; it is not a submitted entry or recorded video. Backup transcript: data/backup-combined-demo.txt, based on combined SHA 1da32c7, completed at revision 12 approved.
