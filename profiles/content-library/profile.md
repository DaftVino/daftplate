# Profile: content-library

## When to use

A curated corpus of reusable items — prompts, playbooks, templates, checklists — organized by category and surfaced through a generated index. The items are the product; the repo exists to keep them findable, consistent and reviewable. Exemplar: a curated library of AI prompt playbooks.

## Stack assumptions

- Items live at `library/<category>/<item>.md`, one item per file, each with `title`, `category`, `summary` and an ISO `updated` in frontmatter.
- `templates/item.md` is the blank a new item is copied from.
- `docs/library-index.md` is generated from the items by `scripts/validate-library.mjs --write-index` and is never hand-edited. CI fails when it drifts.
- No runtime, no build. Node exists only to run the validator.

## Metadata

```profile
verify: node scripts/validate-library.mjs
test: n/a
deploy: n/a
docs-subdirs: designs, adr
roadmap: optional
```

## Extra directories

`library/<category>/` on the first item, `templates/item.md` and `scripts/validate-library.mjs` ship with the profile, `docs/library-index.md` appears on the first `--write-index` run.

## Overrides

None. This profile only adds files; `files-override/` is absent. The workflow is `library.yml` rather than `ci.yml` so it adds to base CI instead of replacing it.

## Relationship to design-vault

`scripts/validate-library.mjs` is `design-vault`'s `validate-vault.mjs` with a different schema, deliberately duplicated rather than shared. Each ships into a repo that has no daftplate checkout, so a shared module would have to be vendored into both — the one thing repo-standards forbids. Keep `parseFrontmatter` in step across the two files by hand; both carry a comment saying so, and a daftplate test fails if the shared region drifts.
