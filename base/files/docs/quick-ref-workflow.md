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
| The live state of the work — what is in flight, next, and parked | **`ROADMAP.md`** at root | Now / Next / Later rows, each naming its rung |
| A handoff to the next session | **Comment on the issue** | never a file of its own (§6.6) |

"Non-trivial" = multi-PR, touches persisted data, risky enough to review before coding, or an agent executes it unsupervised. Otherwise skip the design doc.

Board variant: this paragraph applies only if `ROADMAP.md`'s `Board:` line names Linear (repo-standards §6.5.1). A repo on GitHub Projects ignores it and keeps writing `#N`. On the Linear board, every issue is still created in GitHub, and management happens in Linear. Name an issue `<short>-<N>` in anything a human reads: PR bodies, comments, handoff notes, commit bodies, chat status reports. `<short>` is the project link text on the `Board:` line, so this repo's issue 42 is `<short>-42`. Use the form on every mention, and for pull requests too. Write another Linear-variant repo's issue as `<its-short>-<N>`, and any other repo's as `owner/repo#N`. The Linear key never appears in prose. After filing, run `/dress <N>`. It sets the issue's project and priority in Linear and reads them back, and `/handoff` sweeps anything still undressed. On a repo without a Linear board it does nothing at all. Neither the `Fixes #N` footer nor a commit summary changes. If your GitHub plan offers custom autolink references, map the prefix `<short>-` to this repo's `/issues/<num>` URL to make the form clickable (`gh api -X POST repos/OWNER/REPO/autolinks -f key_prefix=<short>- -f url_template='https://github.com/OWNER/REPO/issues/<num>' -F is_alphanumeric=false`). Never map it on a public export, whose issues are different ones.

## GitHub Flow (every change)

```
1. Issue exists (or create it)          gh issue view 42
2. Design doc IF non-trivial            docs/designs/2026-07-01-slug.md
3. Branch off main                      git switch -c fix/42-registry-cap
4. Commit (Conventional Commits)        fix(sync): cap registry writes at 8KB
5. Push + open PR                       gh pr create --fill   (body: "Fixes #42")
6. Verify: tests / local-verify pass
7. Squash-merge, delete branch          gh pr merge --squash --delete-branch
8. Issue auto-closes via that footer  (writing ABOUT one? split it: "Fixes" + "#42")
```

Never commit directly to `main`. Branches live days, not weeks. Always branch off
`main`, never off another branch — a stacked branch breaks when its parent
squash-merges, and the fix is `git rebase --onto main <parent-tip> <child>`, not
`git rebase main`.

Branch names are `type/N-slug` — `fix/62-scaffold-dest-guard` — and a pre-push
hook installed by `setup-repo` refuses anything else, plus any direct push to
`main`. Rename with `git branch -m <type>/<issue>-<slug>`; to push once anyway,
`DAFTPLATE_ALLOW_NONSTANDARD_BRANCH=1 git push`. Re-run `setup-repo` in an older
repo to install the hook.

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
