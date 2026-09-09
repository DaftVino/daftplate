# Profile: userscript

## When to use

A single-file browser userscript injected into a third-party site by Tampermonkey or Violentmonkey. No server, no build step, no deploy target — the release artifact is the tagged `.user.js` file itself. Exemplar: `Torn Bookie Live Scores`.

## Stack assumptions

- One root-level `<name>.user.js` carrying a `// ==UserScript==` metadata block. It grows large; 775KB is a real observed size.
- Plain ES in the browser, no bundler. Node exists only for `tests/` and `scripts/`.
- The host site's DOM is not yours and is not versioned. Every selector is a dependency on someone else's markup.
- `@version` in the metadata block is the release version. It, the `CHANGELOG.md` entry, and the git tag are one fact in three places.

## Metadata

```profile
verify: npm test
test: npm test
deploy: n/a
docs-subdirs: designs, adr
roadmap: required
```

## Extra directories

`tests/` on the first test.

## Overrides

None. This profile only adds files; `files-override/` is absent.
