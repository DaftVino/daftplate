## Repo-specific constraints

1. **Zero dependencies is a hard rule, not a preference.** No `dependencies`, no `devDependencies`. A task that seems to need a library needs an ADR first, arguing why 30 lines of `node:` builtins will not do.
2. **Every script is a module first and a command second.** Export the logic as named functions, keep `main(argv)` to argument parsing and exit codes, and end the file with `runCli(import.meta.url, main)`. A test that spawns a subprocess to check pure logic is a test in the wrong place.
3. **Nothing deletes what it did not create.** No recursive delete against a path the tool did not write, ever — not behind a flag, not behind a prompt. Report and stop instead.
4. **A destructive-looking operation is dry-run first.** `--dry-run` prints the exact set of paths that would change and writes nothing; the real run is the same code path with the guard removed.
