# Integration notes

`src/contracts/index.ts` is the shared contract source for application wiring. It matches the fixed event, command, outbox, snapshot, configuration, service, result, and conversation-context contracts from `AGENTS.md`. Finance still uses temporary local declarations and should switch to type-only imports from this module in its next owned change.

`src/app/events.ts` serializes normalized inbound work for the current single-household demo, claims the durable event ID, parses once, executes commands or enqueues replies, and completes the event. `drainOutbox` requires Finance to expose the already-persisted `markDeliveryUncertain` transition before it sends anything; it marks a failed send/receipt write uncertain and stops, avoiding an automatic duplicate delivery.

Integration request for Finance: expose `LedgerStore.markDeliveryUncertain(deliveryId)` through `FinanceService` and implement it in the factory. The store already supports this transition. The shared interface keeps it optional temporarily so independent modules remain buildable; the app deliberately refuses to send until the method exists.

`src/app/runtime.ts` composes provider intake, the local HTTP server, serialized event processing, outbox draining every five seconds, reconciliation every five seconds, and reminders every sixty seconds. Tests can inject mock conversation and finance services. Provider clients and credentials remain outside C's modules.

The HTTP server exposes `GET /api/households/:householdId/snapshot`, a minimal public config response, and a demo-only local cycle route. It binds to loopback. The browser receives no banking credentials or private messages. Startup currently uses mock banking only; live modes fail configuration validation.

Verification on Windows: `npm run typecheck`, `npm run build`, `npm test -- tests/app` (8 tests), and `npm audit` pass. The full suite has 81 passing tests and one Finance-owned teardown failure in `tests/finance/store.test.ts` (`durability across reopen > refuses a database written by a newer schema`): the rejected SQLite open remains locked when the test removes its temporary directory. This needs a Finance-side fix.
