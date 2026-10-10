# Local demo

The default fixture enrolls Mason, Alex and Jordan for October and November electricity cycles. All banking is simulated. Start with Node 20 and run `npm install`, `npm run seed`, then `npm run dev`; open http://127.0.0.1:3000. No Photon, Gemini or Nessie credentials are needed for mock mode.

The current branch is not yet the complete canonical chat-and-payment demo because the Conversation service is not present in this checkout. Finance now implements ledger snapshots, commands, reconciliation, reminders and cycle changes, but `npm run dev` has no chat intake or outbox messenger wired until the Conversation module is integrated. The HTTP page can display Finance snapshot data independently.

`npm run demo` asks Finance to advance to the next configured cycle. Finance enforces the transition and idempotency rules; cycle advance does not settle debts by itself.

Run `npm run seed as the separate operator setup step; it saves resolved account IDs in SQLite and idempotently creates the first configured cycle's bills and contribution requests. Startup reconstructs the process-local mock bank using those IDs and the documented starting balances without provisioning accounts. Restarting resets mock balances while preserving the ledger. Do not restart mid-story. For a fresh local ledger, run `npm run seed -- --reset`; this deletes only the selected SQLite file and its WAL sidecars inside `data/`. Reset is mock-only and refuses databases outside `data/`.

For Nessie, configure operator-created account IDs in the household file, set `BANK_MODE=nessie`, `NESSIE_API_KEY`, and `NESSIE_BASE_URL`, then run `npm run seed` to verify/adopt those accounts. Live Nessie behavior is unverified; see [docs/finance.md](finance.md). The seed command never creates Nessie resources, and the app never falls back to MockBank on a Nessie error.
