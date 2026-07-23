## Context budget

- Read the component you are changing plus its direct imports — not the whole `src/` tree. `docs/code-map.md` (from `/code-map`) is the index; use it before opening anything.
- Never read `package-lock.json`, build output, or `dist/`. If a dependency question comes up, query it (`npm ls <pkg>`) instead of reading the lockfile.
- Session start: `/orient`. Phase or session end: `/handoff`.

## Subagent defaults

- "Where is X styled/rendered?" → an Explore subagent over `src/`.
- Repetitive content or markup edits across many files → a cheaper-model subagent, batched by directory.
