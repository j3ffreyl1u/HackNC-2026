# Devpost draft

Draft only. Nothing has been submitted or published by the frontend agent.

## Project description

Weekend, together is an iMessage trip-planning assistant that helps friends agree on a weekend they can attend and afford. Each friend texts the same assistant in their own private DM. It gathers their dates, private spending limit and preferences, asks for what is missing, and compares options. Everyone must say “I’m in” for the same plan revision. Changing a material detail invalidates the earlier approvals. Free dates are shared with the other trip participants so a clash can be fixed; budgets never are. Notices arrive in separate DMs.

The read-only companion page shows the saved itinerary, map links, cost estimates, sources and acceptance status. Plans with missing essential prices are labelled “maybe”. Demo prices are made up; live prices are estimates from web search. Outdoor stops and recorded driving comparisons connect the plan to the reef-themed Frutiger Aero interface. Unknown drive legs stay unknown, the drive home is excluded, and we do not claim emissions savings. An approved plan can be downloaded as a calendar file; that does not book anything.

The optional Capital One Nessie sandbox tracker reads each friend’s own simulated account, adds up the shared purchases they covered, and shows who would owe whom. Food stays personal. The bot counts purchases the plan explains and privately asks the buyer once, “trip or personal?”, about purchases it cannot explain. The page compares shared spending by category with the plan’s estimates, so nobody has to split a bill on the spot. The bot only reads and calculates. It never moves money, holds funds or connects to a real bank. A separate simulator can create fake sandbox accounts and purchases; the offline page demo uses a local pretend ledger.

## How we built it

The app uses TypeScript, Node and SQLite. Spectrum carries the individual iMessage DMs. Rules handle clear messages, with Gemini used for language interpretation. Deterministic code checks readiness, allocates costs in integer cents and compares each person’s upper estimate with their own limit, including personal costs and contingency. A limit is not a contribution promise. SQLite saves revisions, source evidence, acceptances and the message outbox; duplicate events and stale research results cannot replace the current plan.

Gemini research looks up destinations and estimates prices. The latest live search from Chapel Hill to Boone returned two options and dropped two suggestions without sources. Hotel prices came from Google Hotels via SerpApi; fuel and admissions were labelled “typical cost”. The results are cited and honest about what’s estimated. Listed rates do not guarantee bookable inventory or final checkout prices, and this search does not verify the final phone flow. Live grounding remains experimental. The offline recording backup uses explicitly labelled synthetic research.

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
| Shared-spending page logic | Offline `empty`, `sample`, `uneven`, `even` and tracking-off responses checked with a DOM harness; a stopped-server failure clears stale amounts. Chrome checks at 1440x1000 and 390x844 covered focused navigation, the option picker, source details, unknown-price labels and sample spending. The four views had no horizontal overflow. These checks use simulated ledger data. |
| Live per-friend Nessie sandbox, 2026-10-11 | One simulator run created 3 customers, 3 accounts and 4 purchases. The app’s real reader returned $200 shared, excluding a $45 personal dinner: Mason covered $110, Alex $60 and Jordan $30; nets were +$43/−$7/−$36; calculated transfers were Jordan → Mason $36 and Alex → Mason $7. Chat answers used live sandbox data with a mock phone line; no real message was sent. |
| Purchase clarification, live sandbox | An unexplained $80 casino purchase was flagged and held back from shared totals. This verifies the clarification path against sandbox data, not a real-phone exchange. |
| Calendar download | Approved offline endpoint returns HTTP 200, `text/calendar` and three events. Link visibility checked for every status. Import into a phone calendar is unverified. |
| Live research and separate phone probes | The latest Chapel Hill–Boone search returned two sourced options and discarded two unsourced suggestions. Separate DM, reaction and Gemini probes are documented in `docs/conversation.md`; these do not verify the final combined build on phones. |

**Still unverified:** the page’s spending panel with live Nessie sandbox data; the final build on real phones, including the page and a phone-accessible tunnel; calendar-app import; a full keyboard/accessibility audit; live booking availability and checkout prices; an actual community-source result. Do not replace these gaps with a mocked success claim.

## Recording and judging

Use the two-minute storyboard and offline fallback in [demo-script.md](demo-script.md). It shows the approved plan and “Who covered what”, not deposits into a pooled pot. The local ledger must remain labelled simulated. There is no booking, payment or custody feature.

The team’s brief gives four minutes per judge: two minutes for the demo and two for questions. Mason owns the Photon listener, real-phone check, recording, repository visibility and Devpost submission. Integrated `main` at `19115f3` contains the page. This file is copy for review; it is not a submitted entry or a recorded video.
