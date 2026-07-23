## Pipeline

`brainstorming` → `writing-plans` → `/plan-eng-review` → `using-git-worktrees` → `test-driven-development` → `/gas-deploy` (to `/dev`) → `/qa` → `/review` → `/ship`. Add `/design-review` when the change is visible in the UI.

## Off

- `/land-and-deploy` and `/canary` — `clasp` is the only deploy path; `/gas-deploy` owns it.
- `/benchmark` — no meaningful local perf harness for Apps Script.
