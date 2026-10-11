# Who covered what (Nessie sandbox)

Nobody pays into a shared account. Each friend pays for things with their own money, any time, for any shared cost. The bot watches each friend's own (simulated) bank account, adds up what each person has covered, and works out who would owe whom. It never moves money.

Everything here is a Nessie **sandbox**: fake customers, fake accounts, fake money, including when fetched live. Nothing is a real bank connection, booking, card or custody claim.

## How it works

1. **Plan first.** After everyone approves a plan, the bot knows what the plan expects to spend by category (lodging, gas/parking/tolls, activities).
2. **One account per friend.** For the demo, `npm run simulate:fund -- manifest.json --provision --execute` creates one fake customer and Checking account per friend, plus a merchant per category, and posts each person's purchases ("Mason, $110, hotel").
3. **The reader** (`src/funding/nessie-reader.ts`) only makes GET requests: `accounts/<id>/purchases` for each friend. Every purchase is tagged with whose account it came from and its date.
4. **The ledger** (`trackCoverage` in `src/planning/funding.ts`):
   - Shared categories (lodging, gas/parking/tolls, activities, fees) are split **equally** among everyone on the trip. Food is personal and never split (unless a purchase is flagged shared).
   - Fair shares are whole dollars and always add up to the shared total. Each person's net = covered minus fair share (positive means they are owed). The nets always sum to zero.
   - Transfers pair the biggest debtor with the biggest creditor, at most one fewer than the number of people. They are calculated only.
   - Only purchases from the **trip period** count: from the day everyone agreed to the plan until two days after it ends. A purchase counts once (by id) and only if `completed`.
   - A purchase with no recognisable category is left out and reported, never guessed. A purchase from an account that is not on the trip is never credited to anyone.
5. **Drift notices** compare shared spending with the plan's budget by category ("Gas is over its budget"), one at a time to the group.

## Where people see it

- **The page** (`/api/trips/:id/fund` feeds the "Who covered what" panel): first names, what each person covered by category, the plan's budget by category, and "if the trip ended now" transfers. It never shows a limit, personal food, or purchase ids.
- **Chat** (private to the asker unless noted). Phrases: "who covered what?", "who paid for what?", "what do I owe?", "how's the fund?", "who owes who?" for the status; "remind everyone" sends each person who owes a private "Settling up so far: you owe Mason $30." (at most once a day each); "wrap up the trip" goes to the group with who sends whom. Every message says the money is simulated, and the wrap-up says the bot moves no money.

## Setup

- `FUNDING_MODE=disabled` (default): nothing is read, and fund questions say tracking isn't set up.
- `FUNDING_MODE=mock`: a labelled local simulation with an empty ledger. It never stands in for Nessie.
- `FUNDING_MODE=nessie` needs `NESSIE_API_KEY`, a clean HTTPS `NESSIE_BASE_URL`, and `NESSIE_ACCOUNTS_PATH`, a JSON file mapping each trip member id to that friend's Nessie account id (the simulator writes `data/simulated-accounts.json`). `NESSIE_MERCHANTS_PATH` maps merchant ids to category strings (the simulator writes `data/simulated-merchant-categories.json`).
- A failed read says "I can't reach the bank right now" and shows no numbers. No mock data is substituted.

## The simulator

`npm run simulate:fund -- data/fund-simulation.json [--provision] [--execute]`

```json
{
  "members": ["mason", "alex", "jordan"],
  "purchases": [
    { "memberId": "mason", "category": "hotel", "dollars": 110, "note": "Cabin" },
    { "memberId": "alex", "category": "gas", "dollars": 60 },
    { "memberId": "jordan", "category": "parks", "dollars": 30 }
  ]
}
```

Member ids must match the trip's member ids. Without `--execute` it only previews. `--execute` posts once and **rerunning creates duplicates**. Merchant `category` must be a plain string (the sandbox rejects a list). Run it once.

## Sandbox facts that shape the design

- Amounts are truncated to whole dollars, so everything here is whole dollars.
- The account `balance` field never changes, so the bot sums purchases and ignores it.
- There are no joint accounts and transfers did not work, which is why each friend has their own account and the bot only calculates.
- A purchase's merchant category comes from the simulator's merchant mapping; an unknown merchant stays unclassified.

## Not verified

The reader and simulator have been checked against mocks only for this per-friend design. The earlier single-account version was probed live (read endpoints returned 200). A full run of `--provision --execute` followed by the page and chat has not been done yet.

## Checking odd purchases with the buyer

Nobody is asked about everything. The bot reads each friend's own Nessie account (GET only) and counts a purchase on its own when the plan explains it: a shared category that fits the plan's budget, with overruns absorbed by the plan's contingency. Food stays personal and is never questioned.

A purchase the plan does not explain is held back and its buyer gets one private question: "did your $80 purchase (casino) on Oct 15 go toward the trip? Reply trip or personal". Flagged when the category is unknown, or when it is a shared category the plan never budgeted, or when it pushes a category past its budget by more than the contingency has left. Replying "trip" (or yes) counts it as a shared cost (unknown categories count as other); "personal" (or no) leaves it out. Rules: one question per person at a time (the next comes after they answer), each purchase is asked once, a bare yes counts only while a question is open and nothing else is waiting on a yes, nothing is asked before approval or when the bank cannot be read, and the question never mentions anyone's limit.

The check runs every 2 minutes (`purchaseCheckMs`, 0 turns it off). "Who covered what?" mentions the dollars still waiting on an answer. The page view has an optional `awaitingConfirmationDollars`. Code: `reviewPurchases` in `src/planning/funding.ts`, `checkPurchases` in `src/app/runtime.ts`, tests in `tests/planning/purchase-review.test.ts` and `tests/human/purchase-check.test.ts`.
