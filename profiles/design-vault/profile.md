# Profile: design-vault

## When to use

A design and worldbuilding vault: the documents *are* the product. Edited in Obsidian, versioned in git, read by agents. No application code ships from here. Exemplar: a design and worldbuilding vault.

## Stack assumptions

- Obsidian over a plain markdown tree; `[[wikilinks]]` resolve by note stem, not by path.
- Every content note carries `---` frontmatter with `title` and an ISO `updated` date. ADRs, design plans and root-level docs keep their own formats and are not checked.
- `docs/` is bucketed, not flat: `00-project`, `10-world`, `20-design`, `30-content`, `40-research`, `50-technical`, `90-production`, plus `designs` and `adr`. The numbered scheme comes from a private worldbuilding vault, canonicalized lowercase so it satisfies repo-standards §1.
- A vault that uses named buckets instead edits `VAULT_BUCKETS` at the top of `scripts/validate-vault.mjs`. It is a constant so that changing it is a reviewed one-line diff rather than a configuration format nobody maintains.

## Metadata

```profile
verify: node scripts/validate-vault.mjs
test: n/a
deploy: n/a
docs-subdirs: 00-project, 10-world, 20-design, 30-content, 40-research, 50-technical, 90-production, designs, adr
```

## Extra directories

`scripts/validate-vault.mjs` and `.github/workflows/vault.yml` ship with the profile. Create bucket directories on first content, not at scaffold time — an empty numbered tree is noise.

## Overrides

None. This profile only adds files; `files-override/` is absent. The workflow is `vault.yml` rather than `ci.yml` precisely so it adds to the base CI instead of replacing it.

## Deviation from repo-standards §3

§3 requires `docs/` to be flat except `designs/` and `adr/`. This profile ships seven more subdirectories. `docs/adr/0001-numbered-doc-buckets.md` records the supersession in the scaffolded repo, and the scaffolding session must queue a note to `~/.daftplate/outbox/` so the rule itself gets revisited upstream. Silent deviation is the one unforgivable move.
