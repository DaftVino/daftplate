# CLAUDE.md

## Project

<PROJECT_SUMMARY>

## Key docs

- Architecture: `docs/architecture.md`
- Conventions: `engineering-standards/repo-standards.md` in the `daftplate` repo — canonical, never copied here (its ADR 0001). Your local checkout path is recorded in `~/.claude/CLAUDE.md`.
- Workflow quick reference: `docs/quick-ref-workflow.md`
- Decisions: `docs/adr/` — read before proposing architectural changes
- Active plans: `docs/designs/`

## Commands

```
verify:  <VERIFY_COMMAND>
test:    <TEST_COMMAND>
deploy:  <DEPLOY_COMMAND>
```

Run verify before every push. Never deploy without being asked.

## Workflow rules

The non-negotiable gates live in `~/.claude/CLAUDE.md` and govern this repo. Repo-specific additions only below.

Deviating from a standard requires an ADR here **and** a note queued to `~/.daftplate/outbox/` so the rule itself gets revisited upstream. Silent deviation is the one unforgivable move. Tasks live on this repo's GitHub Project (repo-standards §6.5) — never as draft cards, which agents cannot see.

<!-- profile:constraints -->

<!-- profile:routing -->

<!-- profile:context -->
