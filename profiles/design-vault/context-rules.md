## Context budget

- Read the bucket you are working in, not the vault. The buckets exist so that a session about production never loads the world bible.
- Follow `[[wikilinks]]` deliberately: one hop for context, two only with a reason. A vault is a graph and will happily consume a whole context window.
- `docs/code-map.md` does not apply here — there is no source to index. The bucket scheme is the index.
- Session start: `/orient`. Phase or session end: `/handoff`.

## Subagent defaults

- "Where is X established?" → an Explore subagent across buckets; take its answer and its file list, not its excerpts.
- Bulk frontmatter or link repairs → a cheaper-model subagent, one task per bucket, and never one that rewrites a record to satisfy a check.
