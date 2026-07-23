## Repo-specific constraints

1. **Deployment IDs are load-bearing.** The web app URL is tied to a deployment ID; creating a new deployment changes the URL. Update the existing deployment (`clasp deploy -i <id>`) unless told otherwise. `/exec` is production, `/dev` is head — never hand out a `/dev` URL as released, never test a release against it. See `docs/deploy-runbook.md`.
2. **`executeAs` and `access` in `appsscript.json` are security settings.** Changing either needs a stated reason in the PR description.
3. **Platform limits fail silently.** No new `UrlFetchApp` or `SpreadsheetApp` call in a loop without a documented bound; quotas die quietly under load. Keep any single `PropertiesService` value well under 9KB — chunk instead of growing.
4. **`.clasp.json` is gitignored** — `.clasp.json.example` is its committed twin. A real script ID never lands in a tracked file.
