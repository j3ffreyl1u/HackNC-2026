# Integration notes

`src/contracts/index.ts` is the shared contract source. Finance has switched to it and uses type-only imports. C keeps `markDeliveryUncertain` optional in the public service type; `main.ts` adapts the durable `LedgerStore` transition for application outbox delivery.

`tests/fixtures/events.json` contains normalized group, private-consent, and proposal-reaction samples. Retry handling uses stable event IDs and ignores an already-processed event before parsing again.

`src/app/events.ts` serializes inbound work for the single-household demo, claims the durable event ID, parses once, binds actor and source-event identity, derives a stable command ID from household/event/action, executes, drains persisted messages, and completes the event. Rejected commands are sent privately to the enrolled actor. Unknown actors and commands for another household are ignored.

`src/app/runtime.ts` composes provider intake, the local HTTP server, serialized event processing, outbox draining every five seconds, reconciliation every five seconds, and reminders every sixty seconds. Reconciliation and reminder runs do not overlap. Its integration test uses contract-compatible A/B fakes. The Conversation module is not present in this checkout, so `main.ts` cannot yet instantiate a provider service or start real inbound message intake.

The app supports `BANK_MODE=mock` and explicit `BANK_MODE=nessie`. Nessie requires `NESSIE_API_KEY` and `NESSIE_BASE_URL`, and never falls back to mock. Live Nessie behavior is unverified; see [finance notes](finance.md). Seed is an operator command; startup reuses saved mock account IDs and initializes the fresh in-memory mock balances without provisioning accounts.

The HTTP server exposes `GET /api/households/:householdId/snapshot`, a minimal public config response, and a demo-only local cycle route. It binds to loopback, whitelists snapshot fields, maps unknown households to 404, and maps `CycleTransitionError` to 409.

`tests/app/integration.test.ts` exercises runtime, event handling, outbox delivery, and the HTTP snapshot with fakes. It verifies the app boundary, not the canonical financial story.

Verification on Windows after Finance integration: `npm run typecheck`, `npm run build`, `npm test -- tests/app` (26 tests), and `npm audit` pass. The full suite has 289 passing tests and one Finance-owned teardown failure in `tests/finance/store.test.ts` (`durability across reopen > refuses a database written by a newer schema`): the rejected SQLite open remains locked when the test removes its temporary directory. The Finance branch reported 264 tests passing before integration; live Nessie is unverified.
