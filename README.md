# Splitbot

Splitbot tracks shared household bill agreements and simulated payments. It is a local demo; all transfers in mock mode are simulated.

## Local setup

Use Node.js 20, then run `npm install`, `npm run typecheck`, and `npm test`. `npm run seed` initializes the SQLite household ledger, and `npm run dev` serves the local read-only ledger at http://127.0.0.1:3000. The default fixture is `tests/fixtures/household.json`. See [docs/demo.md](docs/demo.md) for the demo flow and current limitations.

The app binds to loopback. It supports mock mode only at this stage and rejects live mode settings rather than silently substituting a mock. The current `MockBank` stores balances in memory; restarting resets bank balances while the ledger remains on disk. Do not restart in the middle of a demo cycle.

## Commands

- `npm run dev` — start the local ledger page and scheduled finance tasks.
- `npm run seed` — provision mock accounts and save their mappings to the local ledger.
- `npm run demo` — ask Finance to advance to the next configured demo cycle.
- `npm run typecheck` and `npm test` — check the TypeScript source and test suite.

Provider-specific integrations and remaining finance state transitions are tracked in `docs/integration.md` and `docs/demo-limitations.md`.
