# Finance service (Worker B)

Owner: Worker B. Code in `src/finance/**`, tests in `tests/finance/**`. All banking is simulated. Say "shared
household account", never an issued card or a real bank account.

**Verification status at a glance:** everything below is covered by automated tests that run against the
in-memory mock bank or a fake `fetch` (264 tests passing). **Nothing has been verified against live Nessie**;
see [Verification](#verification) and [Nessie adapter](#nessie-adapter-srcfinancenessiets).

## What it does

Turns a group agreement into a confirmed payment and remembers exceptions across months. The application owns
arithmetic, authorization and state. The language model never calculates or authorizes money; the
conversation layer only passes enrolled users' typed commands.

## Public interface

`createFinanceService({ store, bank, clock, newId }): FinanceService` (`src/finance/index.ts`). Types come
from `src/contracts/index.ts`. `store` is `LedgerStore.open(path)`; use `':memory:'` for tests.

| Method | Behavior |
| --- | --- |
| `execute(command)` | Validates and applies one command atomically, then sends any approved transfer. Returns `accepted`, `duplicate` or `rejected {code, userMessage}`. `accepted` never means money moved. |
| `reconcile(householdId)` | Resolves uncertain bank operations first, then sends never-sent ones. Safe to call every 5 s. |
| `getSnapshot(householdId)` | Public read model. Derived from the ledger, no bank call. |
| `getConversationContext(actor, space, targetMessageId?)` | What that actor may act on in that space. |
| `pendingMessages()` / `enqueueMessage()` / `recordDelivery()` | Durable outbox. `recordDelivery` also binds a proposal message to its proposal version. |
| `lookupProposal(providerMessageId)` | The exact proposal and version a message carried, or `null`. |
| `advanceDemoCycle(householdId, cycleId)` | Idempotent; next configured cycle only. |
| `processReminders(householdId)` | Limited private reminders. Call about once a minute. |
| `bootstrapHousehold(config)` | Idempotent enrollment; never touches ledger state. |
| `seedDemoBanking(config)` | Operator-run. Returns the config with resolved account IDs; reuses saved mappings. |
| `claimInbound(eventId)` / `completeInbound(eventId)` | Inbound event dedupe. `claimInbound` is false only for an already-processed event. |
| `close()` | Closes the database. |

Typed errors (thrown, not returned): `CycleTransitionError` (`reason`: `unknown_household`, `unknown_cycle`,
`not_next`, `prior_unpaid`, `unresolved_operations`; map to HTTP 409), `UnknownActorError` (not enrolled),
`FinanceConfigError` (bad enrollment or unknown household in `getSnapshot`; also missing Nessie
configuration), `NessieUnavailableError`. Ordinary invalid user actions are *returned* as `rejected`, not thrown.

### Wiring notes for the app

- Derive `commandId` deterministically from household + source event + action. A replay then returns `duplicate`.
- After `execute`, send `pendingMessages()` through the messenger and `recordDelivery` each one. A rejected
  command's `userMessage` should go privately to the actor.
- Run `reconcile` about every 5 s and `processReminders` about every 60 s, never overlapping. Serialize per household.
- Seeding is an operator command (`seedDemoBanking`), never automatic at startup.
- **The mock bank is in memory.** After a restart against the same SQLite file the mock balances are lost while
  the ledger remembers payments. Don't restart mid-demo, or use a fresh ledger.

## Money model

- Every amount is integer USD cents. `splitEqual` gives remainder cents to the earliest members in configured
  order (100 → 34/33/33). Non-integer or negative input is rejected.
- A **bill** has one **obligation** per member (their equal share) and one **contribution proposal** per member
  with something to pay. Obligations are always the plain equal split; a *request* may differ (see carryover).
- A **proposal** has a purpose (`contribution`, `coverage`, `bill_payment`), a version, required approvers, a
  source and destination account, an amount and an **allocation** (payer, beneficiary, kind `own` / `coverage`
  / `credit_settlement`). Status: `proposed → approved → submitted → pending | unknown → confirmed`, or
  `declined`, `superseded`, `failed`.
- **Allocations** are written only when the bank confirms, attributed to the actual payer and the logical
  beneficiary. "Paid" always means "allocated".

## Banking operations

`bank_operations` rows follow `prepared → submitted → pending | unknown → confirmed | failed`.

1. Approval persists a `prepared` operation in the same transaction as the approval.
2. The processor atomically claims it (`prepared → submitted`) immediately before calling the bank.
3. **Only `prepared` operations are ever sent.** Anything else is resolved by asking the bank (by provider
   transaction ID, else by our operation ID), never by resending. A timeout after the bank may have accepted is
   `unknown`.
4. Only a bank result that is `confirmed`, carries a transaction ID and matches source, destination and amount
   is recorded as paid. A mismatch is `unknown`.
5. A definite failure moves no money. The proposal is reissued as the next version, so everyone must approve
   again and the old message and approvals go stale.
6. Outgoing bill payments also wait while any earlier transfer in the household is unresolved, and are refused
   if the bill's own reserved funds do not cover them.

Provider idempotency is not assumed: the mock bank defaults to a provider that double-spends a repeated
operation ID, so any blind retry shows up in tests.

## Invariants

- A command ID is processed once. Rejections are not recorded, so a corrected retry is judged afresh.
- An approval is unique per proposal, version and actor. Wrong-actor, stale-version and repeat approvals never
  create a second operation.
- One operation ID per bank send; never re-sent after it leaves `prepared`.
- Failed, pending and unknown transfers never count as paid.
- No debt exists before the bank confirms the volunteer's funding. Requests, consent and agreements create none.
- Funds are reserved per bill: a bill can spend only its own confirmed money, even if the account holds more.
- A carried-over credit has one settlement per debt, applied across bills in order, and clears the debt only
  after every payment it depends on is confirmed. Previewing it clears nothing.
- Private coverage requests, balances and failure reasons never appear in the snapshot or in another member's
  context or messages.

## Coverage and debt (`coverage.ts`)

`request_coverage` (private prompt only) → `share_coverage_request` (the debtor alone; "no" stays private, "yes"
posts one group ask naming them) → `offer_coverage` (full remaining share only, one volunteer, no self-cover)
→ one coverage proposal both must approve → bank-confirmed funding → debt. A decline reopens the request, moves
nothing, keeps the proposal history and revives the replaced own-share proposals at a new version. If the
volunteer had already paid their own share, only the additional amount is proposed.

## Carryover and cycles (`billing.ts`, `cycle.ts`)

The debtor's request is their share plus the credit they repay; the creditor's request shrinks by the same
amount; unused credit is retained, never negative. November example: 5,000 / 200 / 9,800 for a 15,000 bill,
debt still 4,800 until the 200 and the 9,800 are both confirmed, then cleared exactly once.
`advanceDemoCycle` requires every prior bill paid and no unresolved operation, is a no-op for the current cycle,
and posts a group statement.

## Read models and reminders

- **Snapshot contribution rows are keyed by payer.** A member's own row has their agreed share and what they
  paid for themselves; money paid for someone else is a separate row with `coveredForUserId`. Summing
  `confirmedCents` per member gives what they actually put in (October: 4,800 / 9,600 / 0).
- The snapshot balance is the ledger's confirmed inflows minus confirmed outgoing payments, not a bank read.
- Reminders: private only, begin 48 h before the due date, at most one per member per bill per 24 h, hard cap of
  3, silent once paid, pending, or covered by an agreement awaiting approval. The cap of 3 is my addition.

## Persistence

SQLite via `better-sqlite3`, schema v3 (versioned migrations, foreign keys on, WAL for files). Tables:
households, members, recipients, meta, bills, obligations, allocations, proposals, approvals,
provider_message_bindings, coverage_requests, debts, settlements, bank_operations, processed_commands,
inbound_events, outbox. Every command's state and outbox changes share one transaction. Delivery is at least
once; a delivery marked `uncertain` is held back, not resent.

## Banking adapter interface

`BankingAdapter` (`bank.ts`): `getBalance`, `submitTransfer` (may throw on network failure; a throw means
"unknown, reconcile"), `getTransfer`, `findTransfer` (`null` only when the bank positively has nothing; otherwise
`unknown`). Optional `BankSeeder.provisionAccount` for demo seeding. `MockBank` supports injected failures
(`fail`, `pending`, `unknown-response`, `throw-before`, `throw-after`), settling, and switching off lookup.

## Nessie adapter (`src/finance/nessie.ts`)

### What is verified and what is not

**Nothing in this adapter has run against the live Nessie service.** No API key was available, and the current
docs site (`https://prod.nessieisreal.com/docs`) is rendered by JavaScript, so it could not be read
programmatically (other hosts returned 403 or 429). The step-11 commit message ("mapped to verified API")
overstates this; the mapping is **not** verified.

| Fact | Source | Status |
| --- | --- | --- |
| Create a transfer *from* an account; get one by ID; list an account's transfers as payer or payee; update or delete only before execution | Official `nessieisreal` Android SDK Javadoc and the `api-demo-starter` wiki | Documented, not exercised |
| Request fields `medium`, `payee_id`, `transaction_date`, `status`, `amount`, `description`; statuses `pending` / `completed` / `cancelled` (SDK also says "executed") | Classic Nessie layout (secondary) | **Unverified** against prod |
| API key passed as a `key` query parameter | Secondary write-ups | **Unverified** |
| Create response uses `_id`, reads use `id` | One third-party report | **Unverified**; the adapter accepts both |
| The sandbox never changes balances; transfers have no payee; cents are truncated to whole dollars; no lookup by a client reference | Third-party 2026 hackathon reports only | **Unverified**, but the design assumes they may be true |
| Base URL | none | **Not known.** No default; `NESSIE_BASE_URL` is required |

### Design consequences

- **The bank's answer is untrusted.** The adapter returns what Nessie reports, including a missing payee or a
  different amount. The processor counts a transfer as paid only when source, destination and amount match, so a
  sandbox that omits the payee leaves the operation `unknown` and nothing is counted.
- **Confirmed means "the transfer record reads back as completed with matching fields", not "a balance moved".**
  Balances are not used as proof.
- **Failures.** A definite 4xx on create is `failed`. A timeout, network error or 5xx on create *throws*; the
  processor records `unknown` and reconciles. It is never resent.
- **Lookup by our operation ID** works only through a tag in `description` (`[op:<operationId>]`), found by
  listing the payer's transfers. List completeness is unverified, so "none found" is `unknown` rather than `null`
  unless `absenceIsAuthoritative` is set. Several matches are also `unknown`.
- **Whole dollars only.** Amounts that are not a multiple of 100 cents are refused before anything is sent. All
  canonical amounts are whole dollars. `allowFractionalDollars` overrides it; the read-back check still catches
  truncation.
- **Seeding is adopt-only.** The operator creates customers and accounts in Nessie and puts the IDs in the
  household config; `seedDemoBanking` verifies they exist and never creates one.
- **Secrets.** The key travels in the request URL, so errors and reasons are redacted before leaving the adapter.

### Configuration

| Variable | Used by | Notes |
| --- | --- | --- |
| `BANK_MODE=nessie` | the app | Selects this adapter; must never silently fall back to the mock bank |
| `NESSIE_API_KEY` | `NessieBank` | Required in Nessie mode |
| `NESSIE_BASE_URL` | `NessieBank` | Required in Nessie mode; verify against current docs |

Put keys in Codespaces secrets (or a git-ignored `.env`); never commit them.

### Live smoke check (not yet run)

`runNessieSmoke(bank, { fromAccountId, toAccountId })` (`src/finance/nessie-smoke.ts`) sends a 100-cent
simulated transfer and records: accepted, payer echoed, payee echoed, amount exact in cents, readable by ID,
lookup by operation tag, and whether both balances moved. It reports findings instead of throwing and never
prints the key. If the report shows the payee is not echoed, live Nessie cannot be used for this flow as designed:
send that finding to Cameron with the fallback below.

**Faithful fallback if the sandbox cannot echo a payee or move balances:** run the demo with `BANK_MODE=mock`,
labelled as mock, or model a transfer as a tagged withdrawal on the payer plus a deposit on the payee (what a
third-party project did). That is a contract change and needs agreement before it is built; it is not built.

## Verification

Commands run on branch `Mason-ledger/nessie-client`, Node v20.20.2:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passes |
| `npm run build` | Passes |
| `npm test` | 264 tests in 11 files pass |
| `npm run demo` | **Not run**: Cameron's script does not exist on this branch |

Tests per file: accounting 13, mock-bank 19, store 24, service 17, engine 42, reconcile 22, coverage 27,
payment 16, carryover 19, views 33, nessie 32. All use the mock bank or a fake `fetch`.

| Area | Mock / fake | Live |
| --- | --- | --- |
| Accounting, approvals, coverage, carryover, payment | Verified | n/a |
| Restart recovery (file-backed ledger reopened) | Verified for an unknown transfer | n/a |
| Nessie contribution transfer, read-back, outgoing transfer | Verified against a fake that follows the assumed shape and its reported quirks | **Not run** |
| Nessie lookup by operation tag | Fake only | **Not run** |

## Known limitations

- An `unknown` operation on a bank that cannot look up by operation stays unresolved. There is no operator
  command to resolve it, and the cycle cannot advance while one exists.
- A debt has one settlement. Credit left over after applying it (when it exceeds the new shares) stays on the
  debt and is not applied later.
- Coverage and bill edits are refused on a bill that carries a carried-over credit.
- A declined contribution has no direct re-request; the member can ask for coverage or the bill can be corrected.
- A failed coverage transfer reissues the agreement for re-approval; the request stays `awaiting_approvals`.
  The `failed` coverage status and the `failed` bill status are defined but unused.
- Declining the outgoing payment holds it; the designated payer can still approve it.
- Payment-approval reminders for the designated payer are not sent.
- Failure reasons from the bank are shown to the affected member privately (for example "insufficient funds") but
  never in the snapshot or to others.
- The mock bank is in memory (see wiring notes).
- Not built: affordability advice, minimum-transfer optimization, restaurant splitting, weighted rent,
  installments, refunds, any real money movement.

## Reproduce

```
npm install
npm run typecheck
npm test
npm run build
```
