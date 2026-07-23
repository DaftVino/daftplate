# Architecture overview

The index for this repo's architecture docs. Small, linked, Mermaid-only views — never one master diagram.

## Views

- **System context** and **container** views live beside this file as `system-context.md` and `containers.md`, added by `architecture-docs` when the system takes shape.
- **Domain map** — who owns what — is `domain-map.md`. Each domain also carries its own doc under its `src/` tree.
- **Flows** — one Mermaid sequence or state doc per high-impact operation — live under `flows/`, added by `feature-flow`.

## Rules these docs live by

- **Migrations and the committed schema are the only schema authority.** `docs/database/database.dbml` and any ERD describe the schema; they never define it.
- **A domain owns writes to its own tables.** Cross-domain changes go through a published interface or an event. `architecture-audit` reports direct-write violations.
- **Docs ship in the PR** that changes the behaviour they describe.
- **Excalidraw and canvas files are scratch.** Nothing implementable may exist solely in one.
- **Mermaid only.** GitHub renders it; `gstack-diagram` edits it. No Structurizr, no new tooling.
