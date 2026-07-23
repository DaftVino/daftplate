## Repo-specific constraints

1. **Migrations and the committed schema are the only schema authority.** ERDs, DBML, and sketches describe; they never define. Changes are additive, reversible migrations.
2. **A domain owns writes to its own tables.** Cross-domain changes go through a published interface or an event, never a direct write; `architecture-audit` flags violations.
3. **Architecture, schema, and flow docs ship in the PR** that changes the behaviour they describe. The review gate checks it.
4. **Excalidraw and canvas files are scratch.** Nothing implementable may exist solely in an `.excalidraw`/`.canvas` file.
5. **Prefer small domain-scoped docs.** `docs/architecture/overview.md` indexes them; the five `.claude/skills/` maintain them.
