# Two-minute demo and video script

This is a storyboard, not a recording. Use a local offline demo as the reliable backup. Every cost/date/source in that backup is synthetic; every ledger amount is simulated. Live phone footage can replace a shot only after Jeffrey coordinates and verifies the final build. Keep real phone numbers, credentials, private caps and personal transactions out of the recording.

## Offline setup

From the frontend worktree, use separate scratch databases:

```sh
cd /Users/masonwang/Documents/Projects/HackNC-2026-web
DATABASE_PATH=/tmp/hacknc-video-chat.sqlite npm run demo:chat
PORT=3100 DATABASE_PATH=/tmp/hacknc-video-page.sqlite DEMO_LEDGER=sample npm run demo:web
```

Use unused filenames to replay the chat story. The page opens at `http://127.0.0.1:3100/?trip=chapel-hill-weekend`; use another free port if needed. `demo:web` has no phone listener, research calls or bank connection. Its four ledger choices are `empty`, `sample`, `uneven`, `even`; `DEMO_FUND=off` hides tracking. No secrets are needed. Do not use `npm run dev`, `CHAT_MODE=photon` or the simulator’s `--execute` for this backup.

The terminal backup prints internal `[group]` labels for shared notices. In the product those notices are delivered to individual DMs. Do not present those terminal labels as iMessage footage or as evidence of a shared chat. Capture the synthetic options, revision notice and approval text, or narrate over the page. Keep the synthetic cap-change step labelled as a demo if showing it; never expose a real person’s limit.

## Two-minute storyboard

| Time | On screen | Say |
| --- | --- | --- |
| 0:00–0:12 | Page introduction, with a small “Offline demo / synthetic plans / simulated spending” caption in the recording. | “We built an iMessage assistant to help friends agree on a weekend trip. Each person texts it privately, so one friend doesn’t have to collect everyone’s details.” |
| 0:12–0:30 | Cropped offline transcript: a targeted question, then two synthetic plan summaries. Keep the full prices-made-up notice in the shot. | “It gathers each person’s dates, preferences and private limit, then asks only for what’s missing. It checks each person’s upper cost, including food and a buffer. These are demo options with made-up prices.” |
| 0:30–0:48 | Synthetic revision notice: an option is dropped, earlier approvals no longer apply. | “When one person lowers their limit, the expensive option stops fitting. The assistant revises the plan and clears the old approvals. Everyone has to accept the new version.” |
| 0:48–1:08 | Overview: approved badge and revision. Use the Itinerary, Costs and Sources navigation buttons to show each focused view. | “This page is the saved view of the plan. You choose and accept through your DM with the assistant. Here you can see the itinerary, cost estimates and sources. Missing essential prices make an option a maybe.” |
| 1:08–1:20 | Itinerary: numbered stops, map links, outdoor notes and recorded driving time, then the approved calendar link. | “The page highlights outdoor stops and recorded driving time. It can download the accepted itinerary as a calendar file. Nothing is booked, and prices and availability still need checking.” |
| 1:20–1:48 | Open Costs, then show “Who covered what” using `sample`, keeping its simulation label visible. Point to Mason covered $110 / is owed $43, Alex covered $60 / owes $7, Jordan covered $30 / owes $36. | “Each friend pays for things from their own money. The tracker adds up shared costs and calculates who would owe whom. In this local simulation, Mason covered more; Alex and Jordan would owe him. Personal food stays separate. The bot only reads and calculates; it never moves money.” |
| 1:48–2:00 | Hold on the simulation label and approved revision. | “Nessie is a sandbox with fake accounts and fake money. The real benefit is getting friends to agree on one current plan, with clear costs and less coordination work.” |

Read the narration once with a stopwatch and trim pauses to stay below two minutes. The storyboard’s timestamps are a target, not evidence of a timed recording. Do not spend the video on unverified setup.

## Thirty-second answers for judges

**How does the money work?**

“Everyone pays with their own money. One friend might cover a hotel and another might pay for gas. The tracker adds up those shared purchases, works out each person’s equal share, and calculates who would owe whom if the trip ended now. Food stays personal. Nobody has to split a bill on the spot, and the bot never moves money or holds a shared pot.”

**Is this real banking?**

“No. Capital One Nessie is a sandbox with fake customers, fake accounts and fake money. The local page demo uses a pretend ledger without contacting Nessie. The optional adapter reads purchases from each person’s own sandbox account. A separate simulator can create fake purchases, but the agent only reads and calculates. We haven’t verified the complete per-friend sandbox flow on the final build.”

The brief gives four minutes per judge: two for the demo and two for questions. Keep these answers near thirty seconds each; rehearse them rather than claiming they have already been timed.

## Screenshot shot list

1. Reef introduction and the shared-plan heading. Capture at 1440x1000 and 390x844 if browser control is available; record the actual viewport.
2. Approved plan: current revision, approved badge, acceptance count and calendar link.
3. Expanded itinerary and map links, then cost breakdown with demo labels visible.
4. Expanded source claim and uncertainty, plus the existing “maybe” option with its price-not-found label.
5. `sample` spending panel: simulation label, three names/nets and calculated settlement.
6. Optional `uneven`: Mason is owed $251, Alex owes $118, Jordan owes $133; $80 without a recognised category is excluded.
7. Outage view after stopping only the page demo: tracking unavailable and no previous amounts.

Native Chrome screenshots were inspected at 1440x1000 and 390x844 during the follow-up QA pass; they were not exported as recording-ready image files. The approved plan and sample mobile spending rows were inspected, plus desktop empty/uneven/even spending panels. Whole-document overflow measurements, expanded source layouts, actual calendar import and phone/tunnel viewing remain unchecked. Browser control later failed, so tracking-off and outage behavior retain automated rather than browser verification. No video or timed rehearsal was produced. State-preview support exists on the backend branch, but a saved-revision mismatch is logged in `frontend-requests.md`; corrected previews are not integrated here yet.
