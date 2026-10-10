# Local demo

The default fixture enrolls Mason, Alex and Jordan for October and November electricity cycles. All banking is simulated. Start with Node 20 and run `npm install`, `npm run seed`, then `npm run dev`; open http://127.0.0.1:3000. No Photon, Gemini or Nessie credentials are needed for mock mode.

The current branch is not yet the complete canonical chat-and-payment demo. The HTTP server and compact read-only page are wired, but the snapshot route cannot show ledger data until Finance implements `getSnapshot`. `execute`, `reconcile`, `advanceDemoCycle`, `getConversationContext`, and `processReminders` are also still unimplemented in the Finance service. The Conversation service is not present in this checkout, so `npm run dev` currently starts the local web shell without chat intake or outbox delivery. Errors remain visible as unavailable snapshots or scheduled-task errors; the app does not invent successful financial state.

`npm run demo` delegates cycle creation and idempotency to Finance; it will fail until `advanceDemoCycle` is implemented. Once available, cycle advance must not settle debts by itself.

The app re-seeds the in-memory mock bank when it starts, reusing account IDs saved in SQLite. Restarting resets mock balances while preserving the ledger. Do not restart mid-story. For a fresh local ledger, run `npm run seed -- --reset`; this deletes only the selected SQLite file and its WAL sidecars inside `data/`. Live mode and databases outside `data/` are refused by reset.
