## Context budget

- The userscript is the repo. **Never read it whole**, at any size, for any reason. `docs/code-map.md` (from `/code-map`) is the index; grep it for the symbol, then `Read` with `offset`/`limit` around the anchor.
- Regenerate the map with `/code-map` whenever a session moves declarations; a stale anchor is worse than none, because it is trusted.
- Session start: `/orient`. Phase or session end: `/handoff`.

## Subagent defaults

- "Where is X handled?" → an Explore subagent over the script; take its answer, not its file dumps.
- Mechanical batch edits (renames, repeated call-site changes) → a cheaper-model subagent, one task per anchor region from the map.
