# Coordinated live DM test

Owner: Jeffrey coordinates recipients, timing and messages. C supplies enrollment, persistence and verification. This document authorizes no messages by itself. Shared `main` is updated only by Jeffrey.

## Before the run

1. Use the combined checkout approved by Jeffrey (currently `21073ad`, or his subsequently verified `main`). Record `git rev-parse HEAD`.
2. Run `npm ci`, `npm run typecheck` and `npm run build`. Node 20.20.2 is the established runtime. Do not use C's stale A/B snapshot branch as the combined test baseline.
3. Jeffrey confirms the fixed participants, their consent, the sender identities and the test time. Only then start Photon mode: startup can retry saved outgoing messages.
4. Use a **new** local SQLite path for this coordinated run. Do not reuse a demo database or a prior group's outbox.
5. Keep credentials in `.env`, and phone enrollment in ignored `data/live-trip.json`. Do not share those files in Slack or commit them.

Example enrollment structure; replace every placeholder, including the actual consent timestamp:

```json
{
  "tripId": "coordinated-dm-test",
  "groupSpaceId": "coordinated-dm-test",
  "mode": "direct",
  "timeZone": "America/New_York",
  "participants": [
    {
      "memberId": "member-a",
      "displayName": "Participant A",
      "providerUserId": "+15551234567",
      "consentedAt": "REPLACE_WITH_ACTUAL_ISO_TIMESTAMP"
    }
  ]
}
```

Add every consenting participant. Direct mode uses a logical `groupSpaceId`; it sends shared plan messages separately to the enrolled phones. Approval requires every consenting member, so the coordinated three-person story needs three enrolled participants.

Set these existing `.env` values for the first stage:

```dotenv
CHAT_MODE=photon
RESEARCH_MODE=mock
CALENDAR_MODE=manual
FUNDING_MODE=disabled
TRIP_CONFIG_PATH=data/live-trip.json
DATABASE_PATH=data/coordinated-dm-test.sqlite
PORT=3000
SPECTRUM_PROJECT_ID=REPLACE_LOCALLY
SPECTRUM_PROJECT_SECRET=REPLACE_LOCALLY
GEMINI_API_KEY=REPLACE_LOCALLY
GEMINI_MODEL=gemini-3.8-flash
```

The intent parser uses Gemini even when research is mock. After Jeffrey approves startup, run `npm run dev` (Node uses `--env-file=.env`). Open the read-only plan page on the agent machine with `http://127.0.0.1:3000/?trip=coordinated-dm-test`.

## Stage 1: actual DMs, synthetic research

Use future test dates agreed with Jeffrey. These examples are messages for the consenting human participants to send, not an automatic send script.

| Step | Input | Expected result |
| --- | --- | --- |
| Private constraints | Each member sends their own maximum ($200/$250/$300), availability and preferences | Constraints retain that member's identity; no cap is included in shared replies |
| Basic trip facts | Confirm departure city, two nights, vehicle access and NC mountains | Specific missing-information questions stop once answered; dates become timezone-qualified intervals |
| Plans | `show plans` | Two feasible fixture options at $180/$190 plus any clearly provisional option; receipts are bound to the actual proposal messages |
| Select | `pick CANDIDATE vREVISION` | Selection requests review and acceptance; it does not approve the trip |
| First acceptance | One person sends `accept CANDIDATE vREVISION` | Only that person is accepted; others remain pending |
| Material change | The first person privately sends `my max is $180` | Revision advances; old acceptance is cleared; $190 no longer fits; $180 remains |
| Renewed approval | Select the $180 candidate, then each member accepts its exact current revision | All three must accept before approved; page and chat show the same revision |
| Reaction binding | React to an old proposal, then to the current acceptance-request message | Old/selection-message reactions cannot count as current acceptance; a current actionable target resolves exactly |
| Guide | `guide: It is raining. What can we do near the next stop?` | Sourced fixture alternatives reflect the approved plan and caps; itinerary and approvals remain unchanged |

All Stage 1 research remains synthetic. Use the real candidate IDs and revisions returned by the agent rather than assuming revision 12.

## Stage 2: actual live research display and manually confirmed plan

Coordinate this as a separate run with a new database, setting `RESEARCH_MODE=gemini`. Participants supply their own real test caps and dates. There is no preset live cap: each person's upper allocation must fit that person's stated maximum.

1. Send planning constraints and `show plans`. The group receives a manual worksheet with unknown essential costs; the requester receives a private expiring research link.
2. Open the research link **on the machine running the agent**. It is loopback-only and will not work by tapping it on a participant's remote phone. Click the research button once. Record latency and whether the original answer, citations and Google suggestions appear together. Do not copy grounded output into the database or group chat automatically.
3. Confirm chosen stops in chat using actual candidate ID/revision and timezone-qualified times: `confirm stop CANDIDATE vREVISION LOCATION | START_ISO | END_ISO | tags`.
4. Confirm **total group** low/high cost estimates: `confirm cost CANDIDATE vREVISION lodging $LOW-$HIGH`. Repeat for transport (including parking/tolls), food, activities, fees and contingency. Each material confirmation changes the revision; use the latest value. Confirm a zero only when intentionally stated. Adding a stop requires renewed transport/activity estimates.
5. Verify unknown costs or unconfirmed itinerary still prevent selection/approval. A manually confirmed estimate is not an independently verified quote or booking. If all confirmed upper totals fit all stated caps, select and request fresh acceptance from every member.
6. Restart after Jeffrey approves the timing. Saved constraints/revision/approvals should remain. Any unsent outbox messages may retry. Consumed/expired research links need a new question; grounded results are not retained.

## Record results

Record commit SHA, Node version, topology, research mode, start/end time, each observed step, page/chat revision agreement, restart result and actual live request latency. Keep raw private messages, caps and phones out of the shared report. Label DM transport, group transport, intent parsing and grounded display separately; a passing mock or DM run does not establish group delivery or live affordability.

If any stage fails, stop that stage, record the error and coordinate the next attempt with Jeffrey. C's safe legacy-state error requires author metadata migration or a separate trip; it does not reset existing state automatically. Funding/calendar integrations remain disabled.
