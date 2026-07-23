# Profile: app-monolith

## When to use

An implemented application monolith in one repo: a browser client, a TypeScript service, and a relational database that evolve together. Exemplar: a game or SaaS runtime. A lighter Node + SQLite variant fits a smaller personal tool.

## Stack assumptions

- A TypeScript service backed by a relational database; migrations are the schema authority, Postgres-first but engine-agnostic at the core.
- A browser client in the same repo, sharing types with the service.
- Architecture, schema, and cross-domain behaviour are documented in-repo and reviewed as code, not kept in someone's head.

## Metadata

```profile
verify: npm run build
test: npm test
deploy: /land-and-deploy
docs-subdirs: designs, adr, architecture, database
```

## Extra directories

`docs/architecture/` (Mermaid C4 views plus `flows/`), `docs/database/` (`database.dbml` and per-domain ERDs), and a repo-scoped `.claude/skills/` suite of five architecture skills. `src/` holds the service and client.

## Overrides

No `files-override/` — this profile only adds files. But it does one thing no other profile does: it ships five skills under `.claude/skills/` (`architecture-docs`, `feature-flow`, `domain-module`, `database-schema`, `architecture-audit`). These are repo-scoped by deliberate exception to ADR 0002 — they only make sense inside an app-monolith, so they are never installed user-level. `install-skills.mjs` reads the daftplate-root `skills/` only and cannot reach them; a test proves it.
