# Local demo

The default fixture enrolls Mason, Alex and Jordan for October and November electricity cycles. All banking is simulated. Start with Node 20 and run `npm install`, `npm run seed`, then `npm run dev`; open http://127.0.0.1:3000. The compact page is read-only and polls the snapshot. No Photon, Gemini or Nessie credentials are needed for mock mode.

`npm run demo` asks Finance to advance to the next configured cycle. Finance owns transition and idempotency rules; cycle advance does not itself settle a debt. Some finance methods are still under implementation, so this scaffold surfaces those errors rather than fabricating ledger results.

The app re-seeds the in-memory mock bank when it starts, reusing account IDs saved in SQLite. Restarting resets mock balances while preserving the ledger. Do not restart mid-story. For a fresh local ledger, run `npm run seed -- --reset`; this deletes only the selected SQLite file and its WAL sidecars inside `data/`. Live mode and databases outside `data/` are refused by reset.
