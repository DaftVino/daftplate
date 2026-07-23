## Pipeline

`brainstorming` → `writing-plans` for anything touching more than one workbook → export (`scripts/export-vba.ps1`) → `/review` over the `vba/` diff → `/ship`.

## Off

- `test-driven-development` — VBA has no runner here and Excel cannot be driven headlessly on CI. Verification is the export plus a manual run of the workbook, recorded in the PR.
- `/qa`, `/browse`, the design family — no web surface.
- `/land-and-deploy`, `/canary`, `/gas-deploy`, `/benchmark` — the workbook is delivered by being opened, not deployed, and there is no harness to benchmark.
