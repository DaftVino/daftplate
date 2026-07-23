## Repo-specific constraints

1. **The documents are the product.** There is no application to test and no build to break. A change is correct when it is accurate, findable and linked — not when a suite goes green.
2. **The vault's editing rules are in `docs/vault-guide.md`** — read it before your first edit. The short version: never repair a historical record to make a check pass.
3. **Every note carries `title` and an ISO `updated` date in frontmatter**, and `updated` moves when the content does. An undated note is unciteable.
4. **`docs/` is bucketed `00-project` … `90-production`**, which deviates from repo-standards §3. `docs/adr/0001-numbered-doc-buckets.md` records why; a note is queued to `~/.daftplate/outbox/` so the standard itself gets revisited. Do not add an eighth bucket without amending both.
