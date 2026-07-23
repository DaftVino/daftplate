# Vault editing rules

This vault's product is its documents. These two rules matter more than any check,
and `CLAUDE.md` points here rather than carrying them inline so the router stays
short.

## Never repair a historical record to make a check pass

A superseded design stays as written; a decision that turned out wrong stays as
written. Corrections go in a **new** note that links back to the old one — you do
not edit the record to hide that it was superseded. `scripts/validate-vault.mjs`
reports broken `[[wikilinks]]` precisely so a human can judge them, one by one.
It never rewrites a note, and neither do you: a broken link is often the honest
trace of a note that was deliberately retired, and silently repointing it
destroys exactly the history the vault exists to keep.

If a link is broken because the target genuinely moved, fix the link. If it is
broken because the target was retired, leave it and note why in the linking note.
The validator cannot tell these apart — that judgement is the reason it reports
rather than repairs.

## `.obsidian/` is workspace state, not content

The `.obsidian/` directory holds editor layout, plugin settings and per-machine
workspace state. Nothing in it is authoritative and nothing in it is the product.
`workspace.json` and `workspace-mobile.json` are gitignored because they churn on
every session and would otherwise fill the history with noise. Plugin configuration
you genuinely want to share is the exception — commit those specific files
deliberately, never the whole directory.
