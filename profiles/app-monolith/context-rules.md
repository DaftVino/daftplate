## Context budget

- Read the domain doc first, then `docs/code-map.md`, then the source slice. Domain docs say what owns what; the map says where it is.
- Never read migration history or `database.dbml` whole for a scoped question — grep it.
- `/orient` at session start, `/handoff` at end.

## Subagent defaults

- "Which domain owns X?" → Explore subagent over `docs/architecture/` and the domain docs, not `src/`.
- Cross-domain drift checks → dispatch `architecture-audit` read-only rather than reading every domain.
