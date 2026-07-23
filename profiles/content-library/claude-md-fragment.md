## Repo-specific constraints

1. **One item per file, at `library/<category>/<item>.md`.** The directory and the frontmatter `category` must agree; the validator fails the build when they do not, because a mislabelled item is invisible to everyone browsing by category.
2. **`docs/library-index.md` is generated, never hand-edited** — see `docs/library-guide.md` for regenerating it and the retire-don't-delete rule.
3. **Every item carries `title`, `category`, `summary` and an ISO `updated`.** The summary is one line and is what readers see in the index — write it for someone deciding whether to open the file.
4. **New items start from `templates/item.md`.** A new field in the template is a schema change: add it to `ITEM_FIELDS` in the validator in the same PR, or it is decoration.
