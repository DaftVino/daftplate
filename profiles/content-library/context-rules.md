## Context budget

- Read `docs/library-index.md` first — it is one file, it is generated, and it tells you which items exist without opening any of them.
- Then read the items you are changing plus `templates/item.md`. Never read a whole category to answer a question the index answers.
- Session start: `/orient`. Phase or session end: `/handoff`.

## Subagent defaults

- "Which item covers X?" → grep the index; only fall back to an Explore subagent across `library/` when the index comes up empty.
- Bulk frontmatter normalization across a category → a cheaper-model subagent, one task per category, followed by one `--write-index` run.
