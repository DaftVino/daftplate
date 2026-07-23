# Profile: local-tool

## When to use

A command-line tool or script suite that runs on the developer's own machine. No server, no browser, no hosting, no deploy step — success is `npm test` green and the command doing its job. Exemplar: `daftplate` itself.

## Stack assumptions

- Node ≥20, ESM `.mjs`, run directly. No bundler, no transpiler.
- **Zero runtime dependencies.** `package.json` has no `dependencies` and no `devDependencies`; tests use the built-in `node:test` runner. Adding the first dependency is an ADR, not a commit.
- Every script is both an importable module and a command: named exports for the logic, a `main(argv)` returning an exit code, and one `runCli(import.meta.url, main)` at the bottom. Tests import the functions; nobody tests by spawning.
- `npm test` is bare `node --test`. Positional path arguments are glob patterns on Node 22+ and match nothing.

## Metadata

```profile
verify: npm test
test: npm test
deploy: n/a
docs-subdirs: designs, adr
```

## Extra directories

`scripts/` for the commands, `tests/` alongside. `scripts/lib/` once a helper has three consumers — not before.

## Overrides

None. This profile only adds files; `files-override/` is absent.
