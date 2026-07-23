## Pipeline

`brainstorming` → `/design-consultation` (new surfaces only) → `writing-plans` for anything spanning more than one bucket → `/review` → `/ship`.

## Off

- `test-driven-development` — there is no code under test. A test suite over prose is noise dressed as rigour, and it would make every honest edit look like a regression.
- `/ship`'s test gate and `/qa` — nothing executes; `verify:` runs `validate-vault.mjs`, which checks structure, not behaviour. `/ship` itself stays on for the changelog, version and PR mechanics — only its test gate is off.
- `/land-and-deploy`, `/canary`, `/gas-deploy`, `/benchmark` — nothing is deployed and nothing has a runtime.
