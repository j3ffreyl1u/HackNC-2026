# Conversation module (Worker A)

Owned paths: `src/conversation/**`, `tests/conversation/**`, `docs/conversation.md`.

## Public interface
`createConversationService({ household, intentModel, messenger, getConversationContext, recipientAliases? })` returns the contract's `ConversationService` (`parseInbound`, `sendMessage`, `start`, `stop`).
`getConversationContext` is B's `FinanceService.getConversationContext`, injected by C. The module never imports finance code or a database.

Files: `parser.ts` (commands/replies), `intent.ts` (validates untrusted model output), `normalize.ts` (provider event -> `InboundMessage`), `money.ts` (decimal dollars -> cents), `spectrum.ts` (Photon transport), `gemini.ts` (intent model), `mock.ts` (no-network messenger and intent model).

## Behaviour
- Actor comes from the enrolled `providerUserId` only. Unknown senders, unrelated groups, own/outgoing messages and removed reactions are dropped.
- Fallback forms: `add electricity $144 due 2026-10-15` (also "due Oct 15", "10/15", "15 Oct"; deterministic, no AI), `summary`, `cover <request-id> $48`, `approve <id> v1`, `decline <id> v1`. Title is mapped to a configured recipient (substring match on id/name, or `recipientAliases`); unknown payee -> clarification.
- "yes"/"no" resolve only to a single actionable proposal or the private share-consent question. Several candidates -> ask which. A group message never answers the private question and group replies never mention it.
- Reactions resolve through `getConversationContext(actor, space, targetMessageId)`; the target must also appear in `actionableProposals` at the same version, otherwise ignored.
- Hedged or question wording ("maybe I can cover", "should I approve?") yields a clarification, never a command. "What do I owe?" is a summary.
- `commandId = householdId:eventId:kind`, so a retried event deduplicates in finance.
- Gemini input excludes balances and other users' private history. Its output is validated (decimal amounts with at most 2 decimals, ISO dates, known intents); anything else becomes a clarification. Gemini errors degrade to a clarification so manual commands still work.

## Contract gaps (for C / B)
1. **Open coverage requests are not in `ConversationContext`.** A volunteer saying "I'll cover Jordan" cannot be resolved to a `requestId`. The parser accepts an additive optional `openCoverageRequests?: Array<{ requestId, amountCents }>` on the context (exported as `ParserContext`). Until B supplies it, volunteers use `cover <request-id> $48` with the id in B's group request message.
2. **Dependencies for C to add:** `spectrum-ts@12.10.1` (only when `CHAT_MODE=photon`; imported lazily). Gemini uses plain `fetch` (Node 20), no package.
3. **Env names:** `PROJECT_ID` and `PROJECT_SECRET` (the names the official `create-spectrum-project` scaffold writes; they feed `Spectrum({ projectId, projectSecret })` in cloud mode). Node does not auto-load `.env` like Bun: run with `node --env-file=.env`, plus `GEMINI_API_KEY`, `GEMINI_MODEL`. The spec's `PHOTON_API_KEY` does not match the SDK; C should map or rename.
4. `OutboundMessage.proposalRef` is passed through by C; the Spectrum adapter returns the provider message id so C/B can bind it for reactions.

## Verification status (2026-10-10)
| Area | Status |
| --- | --- |
| Parsing, approvals, coverage dialogue, normalization (mock) | **Tested** - `tests/conversation/*` |
| Spectrum payload mapping | **Mapped to the 12.10.1 type definitions**, tested with objects shaped like those types. **Not run against a live line** (no credentials) |
| Spectrum DM, live (2026-10-10, cloud iMessage, free/shared line, spectrum-ts 12.10.1) | **Verified by hand with a throwaway probe outside this repo**: an inbound DM arrived with `senderId` in E.164 form (e.g. `+1910…`), `space.type` = `dm`, `space.id` = `any;-;<E.164>`; the bot's reply was delivered as iMessage. Mason's number also worked. The conversation adapter itself (`spectrum.ts`) has not yet been run live |
| Spectrum group chat, live | **Not working on the shared line**: with the bot and three people in an iMessage group, no event reached the app (stream was up). Photon docs list creating groups and group events as dedicated-lines-only. Needs a dedicated line, or the DM-only fallback (product decision pending) |
| Spectrum reaction, live | **Unverified** (needs a thumbs-up on a bot message in a working space) |
| Gemini request/response | Request shape from the structured-output docs; the raw response layout is not documented there, so extraction is tolerant. **Unverified live** |
| Gemini image / receipt capture | **Not implemented** (optional; manual entry works) |

Observed: `message.sender.id` is the sender's E.164 phone number, so `providerUserId` in the household config is that number. Read receipts arrive as their own `read` content type and are ignored. Still unverified: how a removed tapback is surfaced (currently any reaction event is treated as added), and whether `space.send` returns a `Message` with an `id` in every case (if not, `send` throws "delivery uncertain" rather than inventing an id). Image attachments expose `read()` bytes, not URLs, so `imageUrls` is unused.

## Run
`npx vitest run tests/conversation`
