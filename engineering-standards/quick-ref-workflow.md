# Quick Ref: Workflow

## Where does it go? (the decision rule)

| It is… | Destination | Form |
|---|---|---|
| A bug, task, or idea to track and close | **GitHub Issue** | `gh issue create` from template |
| Investigation notes while debugging | **Comment on the issue** | `gh issue comment N` |
| A plan for non-trivial work, written before the work | **`docs/designs/YYYY-MM-DD-slug.md`** | design-doc template |
| A lasting, hard-to-reverse decision + rationale | **`docs/adr/NNNN-slug.md`** | ADR template |
| The fix itself | **PR** with `Fixes #N` | code + tests |
| Tests | **`tests/`** in the same PR | code, never markdown |
| A small change's plan | **PR description** | no separate doc |

"Non-trivial" = multi-PR, touches persisted data, risky enough to review before coding, or an agent executes it unsupervised. Otherwise skip the design doc.

## GitHub Flow (every change)

```
1. Issue exists (or create it)          gh issue view 42
2. Design doc IF non-trivial            docs/designs/2026-07-01-slug.md
3. Branch off main                      git switch -c fix/42-registry-cap
4. Commit (Conventional Commits)        fix(sync): cap registry writes at 8KB
5. Push + open PR                       gh pr create --fill   (body: "Fixes #42")
6. Verify: tests / local-verify pass
7. Squash-merge, delete branch          gh pr merge --squash --delete-branch
8. Issue auto-closes via "Fixes #42"
```

Never commit directly to `main`. Branches live days, not weeks.

## Release (when shipping a version)

```
1. Bump version (single source of truth)     chore(release): v2.0.6
2. Update CHANGELOG.md                       Added / Changed / Fixed / Removed
3. Tag                                       git tag -a v2.0.6 -m "v2.0.6"
4. Push tag + create release                 git push --tags
                                             gh release create v2.0.6
```

SemVer: **MAJOR** breaking · **MINOR** feature · **PATCH** fix. No changelog entry without a tag.

## ADR rules

- Write one when a decision is expensive to reverse or you've argued it twice. ~2–5/repo/year.
- Never edit after acceptance — reversals are a new ADR that supersedes (update old Status line only).
- Agents: check `docs/adr/` before proposing architecture changes.
