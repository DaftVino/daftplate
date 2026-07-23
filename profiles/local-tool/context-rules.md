## Context budget

- Read the script you are changing plus its direct imports. `scripts/lib/` is small by design; read it once and remember it.
- Read the test file before the implementation. In this repo the tests are the specification, and they are shorter than the code.
- `docs/code-map.md` (from `/code-map`) is the index once any file passes 50KB. Below that, reading the file is cheaper than the tool calls needed to avoid it.
- Session start: `/orient`. Phase or session end: `/handoff`.

## Subagent defaults

- "Which script owns X?" → grep first; this tree is small enough that a subagent costs more than it saves.
- Mechanical batch edits across many files → a cheaper-model subagent, one task per directory.
