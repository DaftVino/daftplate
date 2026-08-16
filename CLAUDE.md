# CLAUDE.md

## Project

`daftplate` is the source of truth for repo scaffolding, engineering standards, and agent skills across `x:\Projects\`. It produces other repos; it is not an application.

## Key docs

- Architecture: `docs/architecture.md`
- Standards: `engineering-standards/repo-standards.md` (canonical — never copy it into another repo)
- Decisions: `docs/adr/` — read before proposing architectural changes
- Active plans: `docs/designs/`

## Issue tracking

Issues are **created in GitHub** (`gh issue create`, templates) and **managed in Linear** — a deliberate deviation from `repo-standards.md` §6.5 (ADR 0006). Workspace `DaftForge`, team `FORGE`, project [daftplate](https://linear.app/daftforge/project/daftplate-36e233e735dc), kept in step by Linear's GitHub Issues Sync — never create an issue directly in Linear. Dress in Linear within 24h of filing: priority (Urgent=P1 blocks release · High=P2 lands this branch · Medium=P3 follow-up · Low=parked), milestone, blocking relations. Status Done requires evidence attached as a comment. PRs close with `Fixes #N` (GitHub number) — GitHub and Linear sequences drift, never compute one from the other.

## Commands

```
test:     npm test
verify:   node scripts/verify-templates.mjs .
install:  node scripts/install-skills.mjs
machine:  node scripts/check-machine.mjs
```

Run `npm test` before every push.

## Repo-specific constraints

1. **Standards are never vendored.** New repos get a CLAUDE.md pointer plus `docs/quick-ref-workflow.md`. Anything that copies `engineering-standards/` into another repo is a bug.
2. **Layers only differ.** `profiles/<type>/files/` adds; `profiles/<type>/files-override/` replaces a base file and must say why in `profile.md`. A silent collision is a hard error (`apply-layer --strict`).
3. **Dotfile templates are stored `dot-`-prefixed** (`dot-gitignore` → `.gitignore` on copy) so template files never take effect inside this repo. `scripts/apply-layer.mjs` owns that rule.
4. **Scripts stay dependency-free.** `package.json` has no `dependencies` or `devDependencies`; tests use the built-in `node:test` runner.
5. **Nothing deletes what it did not create.** No `rmSync` against a user directory, ever.
6. **Skills live in `skills/`** and are installed to `~/.claude/skills/` — see ADR 0002. Editing the installed copy instead of the source is a bug.
7. Every implementation plan is phased, each phase executable in a fresh session within ~150k tokens, with a files-to-read manifest per phase.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Contested plan/design decision → invoke /deliberate (this repo's three-archetype Codex panel; heavier than a single outside voice)
- Design critique — "is this generic?", identity/craft judgement → invoke /crit (refuses any appearance finding nobody rendered; delegates the critique doctrine to `impeccable`)
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Publish/sync the public export repos (`daftplate`, `daftkit`) → invoke /publish
- Handing off *and* starting a fresh chat ("I'm going to clear") → invoke /continuum (writes the next session's prompt and validates it; delegates the note to /handoff)
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
