# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The `app-monolith` profile and its five repo-scoped architecture skills (`architecture-docs`, `feature-flow`, `domain-module`, `database-schema`, `architecture-audit`), for an implemented TypeScript-service-plus-relational-database monolith. The skills ship into a scaffolded repo's `.claude/skills/` via the `dot-claude/` → `.claude/` rename over a nested subtree — a code path no prior profile exercised, so a test scaffolds the profile and asserts every skill lands. They are never installed user-level: a deliberate exception to ADR 0002, since they only make sense inside an app-monolith, and `install-skills.mjs` reads the daftplate-root `skills/` only (proven by test). The profile allows nested `docs/architecture/` and `docs/database/` doc trees through the `docs-subdirs` allowlist with zero verifier code, and ships an ADR-0001 recording that supersession of repo-standards §3. Mermaid-only, no whole-system master diagram; the composed `CLAUDE.md` measures 59 lines, one under the ceiling. The "a domain owns writes to its own tables" rule is stated as a checkable condition, and `architecture-audit` reports drift read-only as blocking / recommended / polish.
- `## Alternatives considered` in `engineering-standards/templates/adr.md` — the one idea kept from the deliberately-rejected separate `adr` skill (system design §5.6). A separate skill was not resurrected; the field records each real option and why it lost.
- The `office-automation` profile and `scripts/export-vba.ps1`, which exports every workbook's VBA to `vba/<workbook>/<module>.bas` so macro code reviews like code. `-Check` reports drift without writing and is what `verify:` runs. The export stages to a temp directory and replaces only the extensions it produced (`.bas`/`.cls`/`.frm`/`.frx`); nothing deletes a file it did not create. If Excel is not trusting the VBA project object model it fails with the fix rather than silently emptying the export. The workbooks stay tracked — only Excel's lock and backup files are ignored, and `*.xlsm binary` was already in the base `.gitattributes`.
- The `content-library` profile: `library/<category>/<item>.md` items validated against their directory, an item template, and `scripts/validate-library.mjs` — a self-contained validator that also generates `docs/library-index.md` deterministically and fails CI when the committed index drifts from the items. It is `validate-vault.mjs` with a different schema and is deliberately not shared with it: both ship into repos that have no daftplate checkout, so a shared module would have to be vendored into each. A daftplate test asserts the two parsers stay byte-identical.
- The `design-vault` profile: numbered `00-project` … `90-production` doc buckets canonicalized lowercase from a private design vault, an ADR template recording the supersession of repo-standards §3, and `scripts/validate-vault.mjs` — a self-contained validator that ships into the scaffolded repo and checks bucket layout, note frontmatter, and wikilink resolution. It reports broken links and never repairs a record to make a check pass. Frontmatter and links are checked only on content notes: the `designs`/`adr` process buckets and base's root docs keep their own formats. TDD, `/qa` and `/ship`'s test gate are explicitly off for this profile: the documents are the product and a suite over prose is noise.
- The `userscript` and `local-tool` profiles. `userscript` carries the read discipline for a single large injected file and the rule that `@version`, the changelog heading, and the tag move together; `local-tool` carries the zero-dependency and module-first-command-second rules that daftplate itself runs on.
- ADR 0003 (copier rejected, provenance adopted) and ADR 0004 (publication by curated export).
- The ≤150k context-budget rule in `engineering-standards/claude-md-global.md`, plus `engineering-standards/templates/implementation-plan.md`.
- `scripts/lib/provenance.mjs`; `scaffold.mjs` now writes `.daftplate.json` after substitution.
- `scripts/lib/fs.mjs` (`walkFiles`/`EXCLUDED_DIRS`, extracted from `verify-repo.mjs`).
- `scripts/code-map.mjs` and the `/code-map` skill — a greppable symbol index with line anchors, so large files are read in slices.
- `/orient` and `/handoff` skills, and the `SessionStart` probe `base/files/dot-claude/orient-hook.mjs` that invokes `/orient`. The probe no-ops when the skill is absent and sends the 50KB read discipline only in repos that hold a file that large.
- The commit summary formula in `engineering-standards/repo-standards.md` §4.1–4.2.
- `/brief`, `/gas-deploy`, `/insist`, and `/curious` — four skills that change how a session behaves rather than what it can do — plus `base/files/dot-claude/question-gate.mjs`, the `PreToolUse` hook that makes `/insist` enforceable against auto-approve rather than merely advisory.
- `/deliberate` and `scripts/deliberate.mjs` — three Codex archetypes (`native`, `veteran`, `aesthete`), each strong-willed and each wrong in a different direction, argue a plan or design while Claude chairs and calls the resolution. A round cap of three and loop detection stop them, because agents told to hold their position otherwise argue indefinitely at three model calls a round. Prompts go in on stdin: `codex exec`'s read-only sandbox cannot spawn a reader on Windows, and a large prompt passed as an argument overflows the argument list.
- `setup-repo.mjs --remote` — applies the GitHub-side settings the repo's plan and visibility allow, and reports the rest with a reason and an unblock condition rather than leaving them as a silent chore. `--dry-run` reports without writing.

### Changed

- `REQUIRED_BASE_FILES` now includes the orient hook probe, so a base layer missing it fails `verify-templates.mjs`.
- `/new-project`'s §9 checklist no longer lists secret scanning and branch protection as "needs human". On a private repo on the free plan they are structurally unavailable, not merely undone, and the `secrets` CI job is the standing substitute.
- Branch protection now applies to admins (`enforce_admins=true`), so repo-standards §9.7's "even solo" holds. `--remote` prints the emergency unprotect command alongside it.

### Fixed

- `profiles/gas-webapp/profile.md` advertised `test: node --test tests/`, which runs nothing on Node 22+ — the positional argument is a glob pattern, not a directory walk — so every scaffolded gas-webapp repo named a test command that exits 1 against an empty match; it also named `verify: node scripts/local-verify.mjs`, a script the profile never ships, so the first command a fresh repo's `CLAUDE.md` runs exited `MODULE_NOT_FOUND`. Both are now `npm test`. `verify-templates.mjs` grew a `metaValueIssues` check that rejects all three ways a profile's metadata can break in the repo it produces: the `node --test <positional>` form, any value containing an unresolved `<TOKEN>` (which would survive `fillPlaceholders`' single substitution pass and fail the scaffold from a file that looks blameless), and a `scripts/<file>` reference the overlay does not ship.
- `code-map.mjs` ran `git rev-parse` with `shell: true`, so a repo path containing a space word-split and git exited 128. The map header then read `unknown`, silently voiding the staleness check the header itself instructs the reader to perform.
- `code-map.mjs` stamped the map with `HEAD`, but a map is generated and then committed, so the stamp was one commit behind the moment it landed and the freshness check the header prescribes reported every fresh map as stale. The stamp is now the last commit that touched an indexed file, which is stable across committing the map, docs-only commits, and a squash merge, while still moving when indexed source changes. `/orient` §1.3 and `/code-map` §4 follow.
- `code-map.mjs` indexed files git ignores, because `EXCLUDED_DIRS` is a fixed list that cannot know a repo's own ignores. A stale worktree copy under an ignored directory was indexed beside the real file, so every symbol grep returned two plausible anchors — 37% of one repo's index. Now filtered through `git ls-files --cached --others --exclude-standard`, which keeps untracked-but-not-ignored files so a freshly scaffolded repo still maps.

## [0.1.0] — 2026-07-22

### Added

- Repo foundation: canonical root files, tree, `CLAUDE.md`, CI workflow, ADR 0001 (standards canonical here).
- `base/` template layer and the `gas-webapp` + `web-app` profiles.
- `scripts/lib/cli.mjs`, `apply-layer.mjs`, `verify-repo.mjs`, `verify-templates.mjs`, `scaffold.mjs`, `setup-repo.mjs`, `install-skills.mjs` — all test-covered (`npm test`), including end-to-end scaffold tests per profile.
- `setup-repo.mjs` installs the gitleaks pre-commit hook and checks prerequisites; `--check` runs it read-only against any repo.
- Fixed: `repo-standards.md` §2.1 specified `gitleaks protect --staged`, removed in gitleaks 8.30. Now `gitleaks git --staged`.
- `/new-project` scaffolder skill, installed user-level (ADR 0002).
