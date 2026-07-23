# Profile: gas-webapp

## When to use

A Google Apps Script web app: `Code.gs`/`Code.js` server code plus one or more HTML templates, deployed with `clasp`, served from `script.google.com`. Exemplar: a spreadsheet-backed web app.

## Stack assumptions

- `clasp` for push/deploy; `appsscript.json` at repo root; V8 runtime.
- Server code stays in root-level `.js` files (Apps Script's flat file model), not `src/`.
- No build step, no package manager at runtime. `package.json` exists only for dev tooling.

## Metadata

```profile
verify: npm test
test: npm test
deploy: /gas-deploy
docs-subdirs: designs, adr
```

## Extra directories

`docs/deploy-runbook.md` ships with the profile. Create `tests/` on the first test.

## Overrides

None. This profile only adds files; `files-override/` is absent.
