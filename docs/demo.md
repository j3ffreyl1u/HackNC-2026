# Local demo

The default fixture enrolls Mason, Alex and Jordan for October and November electricity cycles. All banking is simulated. Start with Node 20 and run `npm install`, `npm run seed`, then `npm run dev`; open http://127.0.0.1:3000. The compact page is read-only and polls the snapshot. No Photon, Gemini or Nessie credentials are needed for mock mode.

`npm run demo` asks Finance to advance to the next configured cycle. The finance service enforces the transition and idempotency rules; cycle advance does not itself settle a debt. Current finance milestone methods may still be incomplete, so the application reports those limitations rather than fabricating a ledger result.

MockBank is in memory. Restarting the app resets sandbox balances while the SQLite ledger remains. Do not restart mid-story. For a clean demo use a new `DATABASE_PATH` and run seed. Seed does not support `--reset` or live account provisioning.
