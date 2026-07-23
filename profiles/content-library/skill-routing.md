## Pipeline

`brainstorming` → `writing-plans` for anything spanning more than one category → `/review` → `/ship`.

## Off

- `test-driven-development` — there is no code under test beyond the validator itself, which is maintained upstream in daftplate. A suite over the corpus would fail on every honest edit.
- `/qa`, `/land-and-deploy`, `/canary`, `/gas-deploy`, `/benchmark` — nothing runs, nothing deploys.

`/ship` stays on for changelog, version and PR mechanics; its test gate does not apply. `verify:` runs the validator, which checks structure and index freshness.
