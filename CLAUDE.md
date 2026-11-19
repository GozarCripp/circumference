# Circumference: working rules

## HARD RULE: log every change in `GAME-PLAN.md`
- Every change to the project (code, workflow, design decision, settings the owner changed) gets a line in `GAME-PLAN.md` §8 **Change log** (newest first), **in the same commit** as the change.
- New decisions also go in §3, new known issues and to-dos in §5, and shipped work in §4.
- **Read `GAME-PLAN.md` first** at the start of a session, after memory is compacted, or whenever it's unclear what happened before. It's the project's memory.

## Orientation
- **Active development is on the `multiplayer` branch** (live real-time 2.5D with online rooms), published at https://gozarcripp.github.io/circumference/mp/
- **Run locally:** `python3 -m http.server`, then open `http://localhost:8000`. For multiplayer in one browser, add `?net=local` and use two tabs.
- **Owner preferences:**
  - Ask clarifying questions when something is unclear.
  - Keep responses short to save usage limits.
  - Get the owner's OK before pushing to `main` or `foreverquest-uncircumferenced`.
