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


## [open] Offline demo states for the read-only page — asked by front end, 2026-10-11 05:18
P0 task 3 needs every saved-trip state reviewed using the backend's actual snapshots. Please add `DEMO_STATE=gathering|researching|proposed|awaiting_acceptance|approved` to `npm run demo:web`, keeping it offline and clearly labelled demo data. Include an empty-candidates case (`DEMO_CANDIDATES=empty` or an equivalent documented option). The current approved demo already includes an essential-unknown "maybe" option and source uncertainty; please preserve that coverage in the state previews. Keep funding not-ready for unapproved plans and calendar responses 409 until approved. Please document the commands in `docs/api.md` and reply with the commit to integrate into this worktree. Until this exists, our state checks use the documented shapes in frontend regression tests and code reading; they are not end-to-end state or browser verification.
Backend: (reply, date, commit)
