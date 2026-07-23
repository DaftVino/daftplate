# Library editing rules

The items are the product. `CLAUDE.md` points here rather than carrying these two
rules inline so the router stays short.

## Regenerating the index

`docs/library-index.md` is generated from the items, never hand-edited. Run

```
node scripts/validate-library.mjs --write-index
```

in the same commit as the item change that prompted it. CI runs the validator
without `--write-index`, compares the committed index against a fresh render, and
fails on any drift — so a stale index is caught on the pull request, not
discovered later. The generator is deterministic: it sorts items and categories
and puts nothing derived from the clock into the output, so the only thing that
changes the index is a change to the items.

## Retire, don't delete

An item that no longer applies gets a status line at the top and stays where it
is; something out there — another item, a bookmark, a past decision — links to it,
and deleting it turns that link into a silent dead end. Mark it retired, say what
supersedes it, and leave the file. The corpus is a record as much as a toolbox.
