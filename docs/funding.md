# Trip fund (Nessie sandbox)

C exports `createNessieReader(config)` from `src/funding/nessie-reader.ts` and `createFundService(reader, mode, boundRevision?)` from `src/funding/service.ts`. Merge Mason's latest funding commit first; C does not publish a copied planning snapshot.

The running app exposes GET `/api/trips/:tripId/fund`. It only reads the ledger. No bank writes, transfers, automatic funding requests or live account provisioning are in the app. The web fund panel shows aggregate collected/needed, funded status, remaining after completed purchases and plan-versus-actual categories. Member identities, contributions, provider transaction IDs and raw descriptions are excluded from this endpoint.

For Jeffrey's private chat handling, `await fundService.inspect(savedState)` returns B's `plan`, `funding.perMember`, `funding.missingMemberIds` and `spending` when ready. `not_ready` has a reason and no ledger read. Route reminders only to their memberId; never post the private report to the group. Do not assume proposed plans authorize deposits. This module does not implement or send reminders.

## Modes and configuration

- `FUNDING_MODE=disabled` remains the default.
- `FUNDING_MODE=mock` shows an explicitly labeled local simulation, initially with no deposits or purchases. It never silently substitutes for Nessie.
- `FUNDING_MODE=nessie` requires `NESSIE_API_KEY`, a clean HTTPS `NESSIE_BASE_URL`, `NESSIE_ACCOUNT_ID`, and `NESSIE_PLAN_REVISION`.

Use a dedicated sandbox account for the approved trip revision, containing only that revision's trip purchases. When the plan changes, bind a fresh account and update the revision explicitly. A mismatch blocks the report instead of assigning old spending to a new plan. Account balance is not used: the report sums completed, current-revision attributed deposits and subtracts completed purchases. Pending/cancelled transactions do not count. Unknown or ambiguous merchant categories stay unclassified. The reader fails explicitly on malformed amounts/status rather than pretending they are completed.

All Nessie figures are sandbox/simulated, including when fetched live. No real money, bookings or joint account are represented. Whole-dollar contributions come from B's upward rounding; do not round a participant's private cap or disclose it.

## Separate write simulator

Create an ignored local manifest, for example `data/fund-simulation.json`:

```json
{
  "revision": 12,
  "deposits": [{ "memberId": "alex", "dollars": 45 }],
  "purchases": [{ "merchantId": "ACTUAL_SANDBOX_MERCHANT_ID", "dollars": 10 }]
}
```

Replace revision and deposits with `planContributions`' approved revision/requests. Use the actual sandbox merchant IDs; categories come from those merchants when read back. The sandbox account must already exist. The simulator does not create accounts or change the running app's enrollment.

```powershell
npm run simulate:fund -- data/fund-simulation.json
```

This previews payloads only. When deliberately ready to add synthetic transactions:

```powershell
npm run simulate:fund -- data/fund-simulation.json --execute
```

It writes deposits with exactly `member=MEMBER_ID;rev=REVISION` and labels purchases `SIMULATED`. Reruns create duplicate transactions. On any failure it stops without retrying; reconcile existing transactions before another execution. Successful POST does not mean completed: read back status before claiming funded. Never commit the key or real identifiers.

## Verification

C ran 19 tests across funding, app config and HTTP server; all passed. Typecheck passed. These use mock responses, not live Nessie. Live endpoint compatibility, sandbox status timing, fund browser rendering, chat fund questions/reminders and the guide's remaining-fund behavior still require the combined integration/live verification. Jeffrey retains the only Photon listener and coordinates those checks.

## Latest funding/nature wiring (supersedes provisioning notes above)

The running reader now makes GET requests only to `accounts/:id/deposits` and `accounts/:id/purchases` at https://api.nessieisreal.com, with `?key=`. It never fetches merchants. `NESSIE_MERCHANTS_PATH` points to an ignored JSON object mapping merchant IDs to their actual category strings, saved by the simulator when it creates merchants. Unmapped purchases remain unclassified; missing merchant_id, status or whole-dollar amount fails the read rather than being counted incorrectly.

`npm run simulate:fund -- data/fund-simulation.json --provision` previews customer/account/merchant creation plus transaction payloads. Add `--execute` only when deliberately ready to write sandbox data. In provisioning mode each purchase needs `{ "category": "gas", "dollars": 10 }`; the script creates its simulated merchant, substitutes merchant_id, and saves `data/simulated-fund-binding.json` and `data/simulated-merchant-categories.json`. Deposits and purchases explicitly have `status: "completed"`. Configure NESSIE_ACCOUNT_ID and NESSIE_PLAN_REVISION from the binding and NESSIE_MERCHANTS_PATH=data/simulated-merchant-categories.json. No live provisioning has been run by C. Existing-account mode still requires actual merchant IDs and a category mapping prepared by the operator.

Runtime now accepts the existing canonical `request_funding` command and replies privately with B's `describeFund`. Jeffrey owns parsing “how's the fund?” into that command and private reminder intents. Pass `fundService` to `createApplicationRuntime`; main already does so. On approved-trip events it recomputes B's status and drift notices outside the DB transaction, then atomically saves `fundingNoticeKeys[revision]`, current fundingStatus, processed event and notice outbox messages. Warnings are not polled automatically without a chat event. Same-revision notice keys survive restart; a new revision has its own keys. Unapproved plans clear the funded gate to unknown. No funding read or report creates an acceptance or moves money.

`createPlannerAdapter` takes optional third options `{ fundContext: async state => ({remainingDollars}) | undefined }`. Main derives it as collected minus completed purchases, and B's guide receives `options.fund` only when a ready report exists. Disabled/unapproved funds remain absent. Unavailable reads fail explicitly. The private live grounding view uses the same remaining amount as prompt context without modifying/storing the grounded output; it is not proof that the suggestions' prices were found.

The snapshot endpoint now adds public `nature.summaries` and optional `nature.comparison` from B's `outdoorSummary`/`drivingComparison`. The viewer displays outdoor stops, recorded drive minutes, unknown legs, and the fact that driving home is excluded. Mock research plan replies include those same summaries. Unknown legs prevent a comparison; there are no emissions claims. For the manual live worksheet, outdoor stops remain absent until people confirm a real itinerary; no nature stops are invented.

Backup transcript of the combined 1da32c7 offline demo completed successfully and is saved locally at data/backup-combined-demo.txt with its fresh SQLite database. This is a transcript, not a recorded two-minute video. Jeffrey still owns filming and submission. C's current targeted checks: 34 tests passed; typecheck and build clean. Live Nessie compatibility and browser rendering remain unverified.
