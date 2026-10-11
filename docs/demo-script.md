# Two-minute demo and video script

This is a storyboard, not a recording. Use a local offline demo as the reliable backup. Every cost/date/source in that backup is synthetic; every ledger amount is simulated. Live phone footage can replace a shot only after Mason coordinates and verifies the final build. Keep real phone numbers, credentials, private caps and personal transactions out of the recording.

## Offline setup

Use the integrated main checkout (`19115f3`, which contains the page, or a later reviewed build) and separate scratch databases:

```sh
cd /Users/masonwang/Documents/Projects/HackNC-2026
DATABASE_PATH=/tmp/hacknc-video-chat.sqlite npm run demo:chat
PORT=3100 DATABASE_PATH=/tmp/hacknc-video-page.sqlite DEMO_LEDGER=sample npm run demo:web
```

Use unused filenames to replay the chat story. The page opens at `http://127.0.0.1:3100/?trip=chapel-hill-weekend`; use another free port if needed. `demo:web` has no phone listener, research calls or bank connection. Its four ledger choices are `empty`, `sample`, `uneven`, `even`; `DEMO_FUND=off` hides tracking. No secrets are needed. Do not use `npm run dev`, `CHAT_MODE=photon` or the simulator’s `--execute` for this backup.

The terminal backup prints internal `[group]` labels for shared notices. In the product those notices are delivered to individual DMs. Do not present those terminal labels as iMessage footage or as evidence of a shared chat. Capture the synthetic options, revision notice and approval text, or narrate over the page. Keep the synthetic cap-change step labelled as a demo if showing it; never expose a real person’s limit.

For consistent earlier-stage shots, use a separate scratch database per stage:

```sh
PORT=3101 DATABASE_PATH=/tmp/hacknc-video-proposed.sqlite DEMO_STATE=proposed npm run demo:web
PORT=3102 DATABASE_PATH=/tmp/hacknc-video-no-options.sqlite DEMO_STATE=proposed DEMO_CANDIDATES=empty npm run demo:web
```

Candidates, selection and acceptances now match each stage’s revision. Before approval, funding is not ready and the calendar endpoint returns 409.

The latest live Chapel Hill–Boone research returned two options and dropped two unsourced suggestions. Hotel prices came from Google Hotels via SerpApi; fuel and admissions were labelled “typical cost”. Describe that result as “cited and honest about what’s estimated”. Keep this verified research result separate from the synthetic plans in the offline footage.

## Two-minute storyboard

| Time | On screen | Say |
| --- | --- | --- |
| 0:00–0:12 | Page introduction, with a small “Offline demo / synthetic plans / simulated spending” caption in the recording. | “We built an iMessage assistant to help friends agree on a weekend trip. Each person texts it privately, so one friend doesn’t have to collect everyone’s details.” |
| 0:12–0:30 | Cropped offline transcript: a targeted question, then two synthetic plan summaries. Keep the full prices-made-up notice in the shot. | “Free dates are shared so friends can fix clashes; budgets never are. It checks each person’s upper cost, including food and a buffer. These options have made-up demo prices.” |
| 0:30–0:48 | Synthetic revision notice: an option is dropped, earlier approvals no longer apply. | “When one person lowers their limit, the expensive option stops fitting. The assistant revises the plan and clears the old approvals. Everyone has to accept the new version.” |
| 0:48–1:08 | Overview: approved badge and revision. Use the Itinerary, Costs and Sources navigation buttons to show each focused view. | “This page is the saved view of the plan. You choose and accept through your DM with the assistant. Here you can see the itinerary, cost estimates and sources. Missing essential prices make an option a maybe.” |
| 1:08–1:20 | Itinerary: numbered stops, map links, outdoor notes and recorded driving time, then the approved calendar link. | “The page highlights outdoor stops and recorded driving time. It can download the accepted itinerary as a calendar file. Nothing is booked, and prices and availability still need checking.” |
| 1:20–1:48 | Open Costs, then show “Who covered what” using `sample`, keeping its simulation label visible. Point to Mason covered $110 / is owed $43, Alex covered $60 / owes $7, Jordan covered $30 / owes $36. | “Each friend pays for things from their own money. The tracker adds up shared costs and calculates who would owe whom. In this local simulation, Mason covered more; Alex and Jordan would owe him. Food stays personal. It counts purchases the plan explains and privately asks the buyer once, “trip or personal?”, about anything it cannot explain. It never moves money.” |
| 1:48–2:00 | Hold on the simulation label and approved revision. | “Nessie is a sandbox with fake accounts and fake money. The real benefit is getting friends to agree on one current plan, with clear costs and less coordination work.” |

Read the narration once with a stopwatch and trim pauses to stay below two minutes. The storyboard’s timestamps are a target, not evidence of a timed recording. Do not spend the video on unverified setup.

## Thirty-second answers for judges

**How does the money work?**

“Everyone pays with their own money. One friend might cover a hotel and another might pay for gas. The tracker adds up those shared purchases, works out each person’s equal share, and calculates who would owe whom if the trip ended now. Food stays personal. Nobody has to split a bill on the spot, and the bot never moves money or holds a shared pot.”

**Is this real banking?**

“No. Capital One Nessie is a sandbox with fake customers, fake accounts and fake money. The local page demo uses a pretend ledger without contacting Nessie. The optional adapter reads purchases from each person’s own sandbox account. A separate simulator can create fake purchases, but the agent only reads and calculates. We verified sandbox provisioning, purchase readback and chat answers using a mock phone line. The live-data page panel and final build on real phones are still unverified.”

The brief gives four minutes per judge: two for the demo and two for questions. Keep these answers near thirty seconds each; rehearse them rather than claiming they have already been timed.

## Screenshot shot list

1. Reef introduction and the shared-plan heading. Capture at 1440x1000 and 390x844 if browser control is available; record the actual viewport.
2. Approved plan: current revision, approved badge, acceptance count and calendar link.
3. Expanded itinerary and map links, then cost breakdown with demo labels visible.
4. Expanded source claim and uncertainty, plus the existing “maybe” option with its price-not-found label.
5. `sample` spending panel: simulation label, three names/nets and calculated settlement.
6. Optional `uneven`: Mason is owed $251, Alex owes $118, Jordan owes $133; $80 without a recognised category is excluded.
7. Outage view after stopping only the page demo: tracking unavailable and no previous amounts.

Chrome screenshots were inspected at 1440x1000 and 390x844. The focused views, option picker, expanded source details, unknown-price labels and sample spending were checked; all four views fit without horizontal overflow. Local screenshots were saved as `/tmp/weekend-ocean-desktop.jpg` and `/tmp/weekend-ocean-iphone.jpg`. These are desktop-browser checks at phone dimensions, not real-phone verification. Tracking-off and outage behavior also have automated checks. Calendar import, phone/tunnel viewing and a full keyboard/accessibility audit remain unverified. No video or timed rehearsal was produced.

## Verified backend evidence for the recording

On 2026-10-11, one real Nessie sandbox simulator run created 3 customers, 3 accounts and 4 purchases. The app’s real reader returned $200 shared, excluding a $45 personal dinner. Mason covered $110, Alex $60 and Jordan $30; their nets were +$43, −$7 and −$36. The calculated transfers were Jordan → Mason $36 and Alex → Mason $7. No transfers were executed. Chat answers also used live sandbox data with a mock phone line; no real message was sent. An unexplained $80 casino purchase was flagged and held back.

If showing evidence from that run, label it “Live Nessie sandbox / fake money / mock phone line”. Do not present it as a live-data page check or iMessage footage. The offline `sample` panel uses the same accounting example but remains a local simulation. The page panel with live sandbox data and the final build on real phones still need verification.

Mason owns the Photon listener, real-phone check, recording, repository visibility and Devpost submission. This script does not establish that any recording, publication or submission has happened.
