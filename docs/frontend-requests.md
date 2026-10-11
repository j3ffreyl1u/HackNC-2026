# Requests between front end and backend

Append a section; do not edit the other side's entries. Backend answers under your entry. One request per section. Newest at the bottom.

Format:
```
## [open] short title — asked by front end, 2026-10-11 HH:MM
What the page needs and why (what a person would see).
Backend: (reply, date, commit)
```
Mark `[open]`, `[done]` or `[declined]` in the heading.

---


## [done] Offline demo states for the read-only page — asked by front end, 2026-10-11 05:18
P0 task 3 needs every saved-trip state reviewed using the backend's actual snapshots. Please add `DEMO_STATE=gathering|researching|proposed|awaiting_acceptance|approved` to `npm run demo:web`, keeping it offline and clearly labelled demo data. Include an empty-candidates case (`DEMO_CANDIDATES=empty` or an equivalent documented option). The current approved demo already includes an essential-unknown "maybe" option and source uncertainty; please preserve that coverage in the state previews. Keep funding not-ready for unapproved plans and calendar responses 409 until approved. Please document the commands in `docs/api.md` and reply with the commit to integrate into this worktree. Until this exists, our state checks use the documented shapes in frontend regression tests and code reading; they are not end-to-end state or browser verification.
Frontend status: delivered in `c8047a7` (`demo stages: align revisions, DEMO_CANDIDATES=empty`), following `0c8aef6`. Reviewed the commit and documented commands; backend delivery is complete. Integration and frontend browser QA remain separate follow-up work.
Backend: (reply, date, commit)

## [done] Keep saved demo-stage revisions aligned — asked by front end, 2026-10-11 05:34
Read-only review of `0c5f189` reproduced a mismatch in the new `DEMO_STATE` save step: the proposed snapshot has revision 13 with three revision-12 candidates; awaiting_acceptance has revision 13, three revision-12 candidates, selected revision 12 and one revision-12 acceptance. Reproduction used the commit's `applyDemoStatus` in memory, the actual `runMockDemo`, `saveTripIfRevision`, and `getPublicSnapshot`; no backend files were changed. A person sees “Revision 13” beside “Selected plan … revision 12” and an acceptance for the old revision. Please align candidate/selected/acceptance revisions when constructing these synthetic previews, and test the snapshot after the script's save step, not just the pure helper. Gathering/researching have no candidates; approved remains revision 12. Please reply with the fix commit so Mason can integrate the preview support into the frontend branch.
Frontend status: delivered in `c8047a7`. Reviewed `saveDemoStage`, its candidate/acceptance restamping and the regression test that saves through this helper then reads the public snapshot. Backend delivery is complete; these new backend tests were reviewed, not rerun in this frontend worktree.
Backend: (reply, date, commit)
