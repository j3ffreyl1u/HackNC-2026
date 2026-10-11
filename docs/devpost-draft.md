# Devpost draft

Draft only. Nothing has been submitted or published by the frontend agent.

## Project description

Weekend, together is an iMessage trip-planning assistant that helps friends agree on a weekend they can attend and afford. Each friend texts the same assistant in their own private DM. It gathers their dates, private spending limit and preferences, asks for what is missing, and compares options. Everyone must say “I’m in” for the same plan revision. Changing a material detail invalidates the earlier approvals.

The read-only companion page shows the saved itinerary, map links, cost estimates, sources and acceptance status. Plans with missing essential prices are labelled “maybe”. Demo prices are made up; live prices are estimates from web search. Outdoor stops and recorded driving comparisons connect the plan to the reef-themed Frutiger Aero interface. Unknown drive legs stay unknown, the drive home is excluded, and we do not claim emissions savings. An approved plan can be downloaded as a calendar file; that does not book anything.

The optional Capital One Nessie sandbox tracker reads each friend’s own simulated account, adds up the shared purchases they covered, and shows who would owe whom. Food stays personal. The page compares shared spending by category with the plan’s estimates, so nobody has to split a bill on the spot. The bot only reads and calculates. It never moves money, holds funds or connects to a real bank. A separate simulator can create fake sandbox accounts and purchases; the offline page demo uses a local pretend ledger.

## How we built it

The app uses TypeScript, Node and SQLite. Spectrum carries the individual iMessage DMs. Rules handle clear messages, with Gemini used for language interpretation. Deterministic code checks readiness, allocates costs in integer cents and compares each person’s upper estimate with their own limit, including personal costs and contingency. A limit is not a contribution promise. SQLite saves revisions, source evidence, acceptances and the message outbox; duplicate events and stale research results cannot replace the current plan.

Gemini research looks up destinations and estimates prices. `RESEARCH_MODE=live` enables the priced research path; `gemini` uses a private original-answer display and manual planning worksheet; `mock` uses explicitly labelled fixtures. When `SERPAPI_API_KEY` is set, Google Hotels via SerpApi supplies listed hotel rates. The team documented one real Boone search returning properties and rates. That is evidence for one search, not a guarantee of bookable inventory, checkout prices or a verified final end-to-end live flow. The research docs mark live grounding as experimental; do not describe it as production-ready.

## Proposed tracks

- **General:** base entry, subject to the organizer’s current submission rules.
- **Photon / Spectrum:** the assistant receives and replies to individual iMessage DMs. The final combined phone flow still needs a coordinated check.
- **Gemini:** language interpretation and destination research. Name the mode used in the recording; the offline backup uses synthetic research.
- **Capital One / Nessie:** per-friend sandbox purchase reads, shared-cost accounting and calculated settle-up amounts. Everything is fake sandbox money; the bot has no payment action.
- **Frutiger Aero:** a code-drawn reef scene, glass controls, outdoor itinerary stops and comparisons of recorded driving time. These comparisons exclude the drive home and are not emissions estimates.

These are proposed entries, not a declaration of eligibility. Confirm the current track names and rules before submitting. Community connection/impact has not been demonstrated, so do not claim that track on ordinary tourism alone.

## Verification to preserve in the submission

| Checked | Evidence and limits |
| --- | --- |
| Offline three-person trip lifecycle | Real conversation, planning and SQLite modules produce $190/$180 synthetic options; lowering one private cap to $180 invalidates acceptance and removes the expensive option; revision 12 is approved. All costs, dates and research sources are fixtures. |
| Shared-spending page logic | Actual offline `empty`, `sample`, `uneven`, `even` and tracking-off API responses checked against the page renderer using a DOM boundary harness. An actual stopped-server network failure clears stale amounts. Follow-up native Chrome screenshots inspected the approved page at 1440x1000 and 390x844, sample mobile spending rows, and desktop empty/uneven/even panels. Tracking-off/outage checks remain automated; browser control failed before those checks. |
| Calendar download | Approved offline endpoint returns HTTP 200, `text/calendar` and three events. Link visibility checked for every status. Import into a phone calendar is unverified. |
| Live integration evidence reported by teammates | `docs/conversation.md` records separate DM, reaction and Gemini probes. `docs/research.md` records separate Gemini and one SerpApi Boone search. These are not verification of the final combined build. |

**Still unverified:** the final flow on real phones; per-friend Nessie provisioning, readback and page/chat together; whole-document overflow, expanded sources and keyboard/accessibility checks; the page on a real phone; a tunnel opened on a phone; calendar-app import; live booking availability and checkout prices; an actual community-source result. Do not replace these gaps with a mocked success claim.

## Recording and judging

Use the two-minute storyboard and offline fallback in [demo-script.md](demo-script.md). It shows the approved plan and “Who covered what”, not deposits into a pooled pot. The local ledger must remain labelled simulated. There is no booking, payment or custody feature.

The team’s brief gives four minutes per judge: two minutes for the demo and two for questions. Jeffrey coordinates the Photon listener, real-phone checks, recording, repository visibility and submission. This file is copy for review; it is not a submitted entry or a recorded video.
