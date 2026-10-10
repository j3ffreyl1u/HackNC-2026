# Finance service (Worker B)

Status: Nessie section written at step 11. The remaining sections are completed at step 12.

## Nessie adapter (`src/finance/nessie.ts`)

### What is verified and what is not

**Nothing in this adapter has run against the live Nessie service.** No API key was available, and the current
docs site (`https://prod.nessieisreal.com/docs`) is rendered by JavaScript, so it could not be read
programmatically (other hosts returned 403 or 429). Every claim below is labelled with where it came from.

| Fact | Source | Status |
| --- | --- | --- |
| Create a transfer *from* an account; get one by ID; list an account's transfers as payer or payee; update or delete only before execution | Official `nessieisreal` Android SDK Javadoc and the `api-demo-starter` wiki | Documented, not exercised |
| Request fields `medium`, `payee_id`, `transaction_date`, `status`, `amount`, `description`; statuses `pending` / `completed` / `cancelled` (SDK also says "executed") | Classic Nessie layout (secondary) | **Unverified** against prod |
| API key passed as a `key` query parameter | Secondary write-ups | **Unverified** |
| Create response uses `_id`, reads use `id` | One third-party report | **Unverified**; the adapter accepts both |
| The sandbox never changes account balances; transfers have no payee; cents are truncated to whole dollars; no lookup by a client reference | Third-party 2026 hackathon reports only | **Unverified**, but the design assumes they may be true |
| Base URL | none | **Not known.** There is no default; `NESSIE_BASE_URL` is required |

### Design consequences

- **The bank's answer is untrusted.** The adapter returns what Nessie reports, including a missing payee or a
  different amount. The processor only counts a transfer as paid when `transferMatches` finds the same source,
  destination and amount, so a sandbox that omits the payee leaves the operation `unknown` and nothing is counted.
- **Confirmed means "the transfer record reads back as completed with matching fields", not "a balance moved".**
  If the sandbox does not move balances (the smoke check reports this), balances are not proof of payment.
  The household balance in the snapshot is derived from the ledger of confirmed operations, never from a
  Nessie balance read.
- **Failures.** A definite 4xx on create is `failed`. A timeout, network error or 5xx on create *throws*; the
  processor records the operation as `unknown` and reconciles it. It is never resent.
- **Lookup by our operation ID** works only through a tag in `description` (`[op:<operationId>]`), found by listing
  the payer's transfers. Because list completeness is unverified, "no tagged transfer found" returns `unknown`
  rather than `null`, unless `absenceIsAuthoritative` is set. Several matches also return `unknown`.
- **Whole dollars only.** Amounts that are not a multiple of 100 cents are refused before anything is sent,
  because of the reported truncation. All the canonical amounts are whole dollars. `allowFractionalDollars`
  overrides this; the read-back mismatch check still protects against truncation.
- **Seeding is adopt-only.** Nessie account creation endpoints are unverified, so the operator creates the
  customers and accounts in Nessie and puts their IDs in the household config. `seedDemoBanking` verifies each
  account exists and keeps the mapping; it never creates one. Mock-mode seeding is unchanged.
- **Secrets.** The key travels in the request URL, so errors and reasons are redacted before they leave the adapter.
  Nothing logs a URL.

### Configuration

| Variable | Used by | Notes |
| --- | --- | --- |
| `BANK_MODE=nessie` | Cameron's app | Selects this adapter; never silently falls back to the mock bank |
| `NESSIE_API_KEY` | `NessieBank` | Required in Nessie mode |
| `NESSIE_BASE_URL` | `NessieBank` | Required in Nessie mode; verify against current docs |

Put keys in Codespaces secrets (or a git-ignored `.env`). Never commit them.

### Live smoke check (not yet run)

`runNessieSmoke(bank, { fromAccountId, toAccountId })` in `src/finance/nessie-smoke.ts` sends a 100-cent simulated
transfer and records: accepted, payer echoed, payee echoed, amount exact in cents, readable by ID, lookup by
operation tag, and whether both balances moved. It reports findings instead of throwing and never prints the key.
Run it once with a real key and record the result in the verification table below.

| Check | Result | Date | Notes |
| --- | --- | --- | --- |
| Smoke check against live Nessie | **Not run** | n/a | No API key available when this was written |
