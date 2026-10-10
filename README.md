# Splitbot

Splitbot tracks shared household bill agreements and simulated payments. It is a local demo; all transfers in mock mode are simulated.

## Local setup

Use Node.js 20, then run `npm install`, `npm run typecheck`, and `npm test`. Run `npm run seed` to initialize the SQLite household ledger, then `npm run dev` to serve the read-only ledger at http://127.0.0.1:3000. The default fixture is `tests/fixtures/household.json`. See [docs/demo.md](docs/demo.md) for setup and limitations.

The app binds to loopback. It supports mock mode only and rejects live mode settings rather than silently substituting a mock. MockBank balances live in memory and reset on restart; the SQLite ledger persists. Do not restart in the middle of a demo story.

## Commands

- `npm run dev` - start the local ledger page and scheduled finance tasks.
- `npm run seed` - provision mock accounts and save their mappings to the local ledger.
- `npm run seed -- --reset` - reset only a mock SQLite database under `data/`, then seed again.
- `npm run demo` - ask Finance to advance to the next configured demo cycle.
- `npm run typecheck` and `npm test` - check the TypeScript source and test suite.

Provider integrations and remaining finance state transitions are tracked in `docs/integration.md` and `docs/demo-limitations.md`.
