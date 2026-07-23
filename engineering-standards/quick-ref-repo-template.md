# Quick Ref: Repo Template

## Canonical tree

```
repo-name/                     # lowercase-kebab
├── src/                       # source (Apps Script may keep Code.js at root)
├── tests/                     # test code only — never markdown
├── scripts/                   # dev/build/verify tooling
├── assets/                    # images, logos, media
├── docs/
│   ├── architecture.md        # living doc — how the system works
│   ├── designs/               # YYYY-MM-DD-slug.md work plans (create when first needed)
│   ├── adr/                   # NNNN-slug.md decision records (create when first needed)
│   └── *.md                   # setup-guide.md, troubleshooting.md, runbooks…
├── .github/
│   ├── ISSUE_TEMPLATE/bug-report.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/             # CI/CD
├── README.md
├── LICENSE
├── CHANGELOG.md
├── CLAUDE.md
└── .gitignore
```

Create folders only when there's content. No `docs/bugs/`, `docs/fixes/`, `docs/plans/`, `todo.md` — bugs are Issues, fixes are PRs, plans are `docs/designs/`.

## Root files

| File | Required | Notes |
|---|---|---|
| `README.md` | Always | What/why, stack, install, usage, links into `docs/` |
| `LICENSE` | Always | MIT default; `Copyright (c) YEAR James M. Baker` |
| `CHANGELOG.md` | Always | Keep-a-Changelog; every entry has a matching `vX.Y.Z` tag |
| `CLAUDE.md` | Always | Agent router, <60 lines; from `base/files/CLAUDE.md` |
| `.gitignore` | Always | Platform-appropriate |
| `CONTRIBUTING.md` | If public-facing | |
| `SECURITY.md` | If credentials/user data | |
| `*.example` | For every gitignored config | `.env.example`, `.clasp.json.example` |

All other documentation lives in `docs/` — nothing doc-like loose at root.

## New repo checklist

- [ ] Name is `lowercase-kebab`, noun-first
- [ ] Root files above + issue/PR templates copied from `templates/`
- [ ] gitleaks pre-commit hook installed (`gitleaks git --staged`)
- [ ] Server-side scanning: secret scanning + push protection (Settings → Code security) **or**, where unavailable, the `secrets` CI job (§2.1 layer 2)
- [ ] Branch rule requires the `test` and `secrets` checks to pass
- [ ] `CLAUDE.md` assembled from `base/files/CLAUDE.md` filled in (summary, commands, constraints)
- [ ] `docs/architecture.md` stub created
- [ ] ADR `0001-…` if platform choice is non-obvious
- [ ] Branch protection on `main` (require PR)
- [ ] `v0.1.0` tagged at first working state; `CHANGELOG.md` started
