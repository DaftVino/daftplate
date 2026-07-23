# ADR 0001: Numbered doc buckets supersede the flat-docs rule

- **Status:** Accepted
- **Date:** <YEAR>-01-01

## Context

`engineering-standards/repo-standards.md` §3 requires `docs/` to be flat apart from `designs/` and `adr/`. That rule is written for repos where documentation describes code and the code is the product.

In a design vault the documents *are* the product, and there are hundreds of them. A flat `docs/` makes every listing useless and every search ambiguous, and the cost lands on exactly the reader the rule exists to help.

## Decision

`docs/` is bucketed: `00-project`, `10-world`, `20-design`, `30-content`, `40-research`, `50-technical`, `90-production`, alongside the standard `designs/` and `adr/`. The numeric prefixes sort the buckets in reading order rather than alphabetically. Names stay lowercase-kebab, so repo-standards §1 is untouched.

`scripts/validate-vault.mjs` enforces the list, so an eighth bucket cannot appear without a deliberate edit and this ADR being amended.

## Consequences

- `verify-repo.mjs` must be run with `--docs-subdirs=` naming all nine, which the profile's metadata already does.
- A note is queued to `~/.daftplate/outbox/` so repo-standards §3 gets revisited upstream rather than quietly diverging.
- Vaults using named rather than numbered buckets edit `VAULT_BUCKETS` and amend this ADR in the same commit.

## Alternatives considered

- **Keep `docs/` flat and encode the bucket in the filename** (`10-world-harbour.md`). Preserves the standard, but Obsidian's graph and folder panes both become unusable, and the prefix has to be typed into every wikilink.
- **Put the vault outside `docs/`** entirely, in a top-level `vault/`. Sidesteps §3 rather than superseding it, and puts the product of the repo somewhere no standard describes.
