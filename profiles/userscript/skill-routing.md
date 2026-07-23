## Pipeline

`brainstorming` → `writing-plans` → `/plan-eng-review` → `using-git-worktrees` → `test-driven-development` → `/code-map` (the file grew) → `/review` → `/ship`.

## Off

- `/land-and-deploy` and `/canary` — there is no deploy target. The release is a tag plus the raw file URL.
- `/gas-deploy` — wrong platform.
- `/qa` and `/browse` — the app under test is a third-party site the harness cannot log into. QA is manual, in a real browser, signed into a real account.
