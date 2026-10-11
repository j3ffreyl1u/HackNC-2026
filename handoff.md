# Cameron handoff

Updated October 11, 2026. This handoff accompanies Cameron's participant dashboard, reef refinements, and required visual assets.

## Current priority

Build a living participant dashboard that makes the trip easy to understand: a clear itinerary, useful visualizations, group acceptance, costs, and the next step. The user explicitly wants a visually appealing, simple trip experience, rather than an organizer/admin interface.

Keep the bright Frutiger Aero identity. The interactive underwater landing page remains available. Use existing sourced assets and code-based effects; the user prefers stock/open-source imagery and does not want AI-generated art.

## Where the work lives

- Active implementation: `data/funding-v3/`.
- Branch: `Cameron-app/funding-v3`.
- Previous branch head before this delivery: `93703cd` (`polish(web): refine reef fish, hover response and accessible glass layout`).
- Dashboard, subsequent reef refinements, required assets, and this handoff are included in the commit containing this file. Use `git log -1 Cameron-app/funding-v3` after fetching to identify the delivery; `93703cd` does not contain it.
- Owned web files are mirrored into the workspace root for the IDE. The worktree is the implementation source of truth.
- The root checkout also contains other changes. Do not broadly stage, reset, clean, or switch its branch.

## Open the dashboard

`http://127.0.0.1:3000/?view=dashboard`

To select a specific saved trip:

`http://127.0.0.1:3000/?view=dashboard&trip=chapel-hill-weekend`

The landing page's primary button now opens this dashboard, preserving the trip ID. “Visit the reef” returns to the landing page with the same trip. The dashboard uses the existing `/` route; no new server route is required.

At the time of this handoff, a local viewer is responding on port 3000 and showing the approved synthetic trip at revision 12. Its fund tracking is disabled. Do not start a second process on that port or kill a process without identifying it.

If the viewer is stopped, start a local mock-only preview from the active worktree in a new PowerShell terminal:

```powershell
Set-Location C:\Users\camer\.vscode\HackNC-2026\data\funding-v3
$env:CHAT_MODE='mock'
$env:RESEARCH_MODE='mock'
$env:CALENDAR_MODE='manual'
$env:FUNDING_MODE='disabled'
$env:TRIP_CONFIG_PATH='tests/fixtures/trip.json'
$env:DATABASE_PATH='C:\Users\camer\.vscode\HackNC-2026\data\backup-combined-demo.sqlite'
$env:PORT='3000'
node --import tsx src/app/main.ts
```

This uses an existing synthetic database. Do not read or print `.env`, change live credentials, send live messages, or seed a live account to preview visuals.

## Dashboard implementation

### Files

- `web/index.html`: dashboard shell and navigation; landing-page dashboard link.
- `web/app.js`: dashboard rendering, interactions, polling, and fund visualization.
- `web/styles.css`: responsive dashboard layout, readable Aero surfaces, timeline, charts, and status styles.

### What is implemented

- Trip title, date window, participant count, and revision.
- Prominent selected-plan/option-preview status and synthetic-data labeling.
- Summary of dates, per-person estimated costs, outdoor stops, recorded driving, and exact-version acceptance.
- Day-by-day itinerary with selectable day filters, ordered stops, saved times, outdoor tags, travel estimates, and real Google Maps search links.
- Option-preview buttons. They only change the viewed option; selection and acceptance still happen in chat.
- Cost-category visualization with textual dollar values and an expandable item/per-person breakdown.
- Participant roster with acceptance progress. Counts use unique enrolled actors, exact candidate ID, and exact revision.
- Contextual next-step guidance for gathering, reviewing, selecting, stale plans, missing prices, and accepted plans.
- Outdoor summaries and B's driving comparison where available. No emissions claims.
- Sources and visible fixture/provisional/unknown-price notices.
- Shared-fund rendering for disabled, loading, not-ready, unavailable, and active funding states. Active states show collected, spent, remaining, contribution progress, and spending versus planned categories.
- Refresh every five seconds, with request timeouts, no overlapping refreshes, and refresh on returning to the tab. Unchanged snapshots do not rebuild the dashboard. Day choice, option preview, and disclosure state persist during updates.
- Offline messaging preserves the last saved trip. Failed fund reads do not display invented fallback amounts.
- Dashboard does not load the heavyweight reef/WebGL module. Landing-page fish, dolphin, seaweed, and anemone remain in the reef view.
- Responsive layout, keyboard-accessible controls, and reduced-motion support.

### Data sources

- `GET /api/trips/:tripId/snapshot`: existing sanitized public snapshot, including nature summaries added by the server.
- `GET /api/trips/:tripId/fund`: existing aggregate fund public view.
- No POST/write operation is added by the dashboard.

### Important limitations

- The public snapshot has no trip timezone. The dashboard explicitly labels saved stop times **UTC**; it does not invent local times. A follow-up can add a safe public timezone field through C's shared contract and server, then format the schedule in that timezone.
- Displayed ranges are plan estimates, never private budget limits. Unknown prices are excluded from the chart and labeled unconfirmed.
- The landscape banner is existing reference imagery, explicitly labeled as scenery rather than the actual destination. See `docs/visual-assets.md` for provenance. Its commercial stock licensing has not been established.
- This is a loopback/local saved view. Public hosting/authentication is not implemented by this work.
- The current local viewer has funding disabled; the active fund chart has not been visually exercised against a enabled funding service in this dashboard pass.

## Reef and funding work already present

This delivery also contains the preceding visual refinements: sourced fish models, Three.js/vendor files, larger interactive anemone, draggable fish, spring-based tentacle contacts, dolphin/seaweed/bubbles, and cropped reference assets (globe, laptop, greenery). Preserve these when integrating the dashboard.

The existing funding implementation includes a read-only Nessie reader, B's contribution/funding/spending functions, a separate simulated-money writer script, cached fund reads, aggregate public output, guide remaining-fund context, and saved drift-notice keys. The dashboard consumes that existing service; it does not create a money-moving path.

## Inspection performed in this pass

- Captured the actual local saved-trip dashboard at 1440×1000 and 390×844.
- Both captures reported no page JavaScript errors and no horizontal overflow.
- Screenshots: `data/dashboard-desktop.png` and `data/dashboard-mobile.png` in the workspace root.
- Local capture helper: `data/dashboard-preview.mjs` (ignored scratch tooling, not a production dependency).
- A small synthetic-data badge was added after the captures.
- No automated domain tests, typecheck, or build were run in this dashboard pass. Earlier teammate test counts do not verify these new changes.
- No live Photon, Gemini research, or Nessie transaction calls were sent in this pass.

## Next integration steps

1. Review the dashboard and the current worktree diff. Confirm the final synthetic badge and exercise day filters, option previews, disclosures, keyboard focus, and loading/error/funding states.
2. If requested, run the combined typecheck, build, and relevant tests before declaring integration verified.
3. The delivery includes Cameron-owned changes and required assets/license documents. Preserve those dependencies when cherry-picking. Do not stage peers' files from the shared root checkout.
4. Jeffrey: fetch `Cameron-app/funding-v3`, inspect its latest commit and diff, and use the actual delivery SHA. Do not cherry-pick `93703cd` as if it contained this dashboard. Cameron will report the published SHA separately.
5. Integrate against Jeffrey's latest combined branch, preserving A's availability/chat changes and B's latest funding/nature/question changes. Recheck the remote head first; this pass did not fetch or verify it.
6. Jeffrey owns shared-branch/main integration and coordinated live DM testing. Only one process may listen on the Photon line. No live messages without his go-ahead.

## Ownership boundaries

- Cameron/C: `src/app`, `src/contracts`, `src/storage`, `src/funding`, `web`, scripts, shared configuration/docs.
- Jeffrey/A: conversation, availability, transport, coordinated live chat, combined integration.
- Mason/B: planning, research, pure funding/nature calculations.

Do not replace peers' modules with stale snapshot copies. Do not push or merge root `main` as part of a visual change.
