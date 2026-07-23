# Base layer

What every scaffolded repo gets, regardless of type. Profiles overlay this; they never restate it.

## Copy rules

`scripts/apply-layer.mjs` copies two directories and nothing else:

| Directory | Behavior |
|---|---|
| `files/` | additive. A collision with a file base already wrote is a hard error under `--strict`, which `/new-project` always passes. |
| `files-override/` | declared replacement of a base file. Always overwrites. Must correspond to a real base file, and the profile's `profile.md` must say why. |

Two renames apply at any depth:

- `dot-<name>` → `.<name>`, for files and directories.
- `gitignore-append` (profiles only) is appended to the destination `.gitignore` rather than copied.

Everything outside those two directories — including this document — is never copied.

## Placeholders

`/new-project` replaces these in every copied file via `scripts/scaffold.mjs`. `scripts/verify-repo.mjs` fails any repo where one survives in any text file.

| Placeholder | Filled with |
|---|---|
| `<PROJECT_NAME>` | the repo name, lowercase-kebab |
| `<PROJECT_SUMMARY>` | 2–3 lines: what it is, who uses it, what it runs on |
| `<YEAR>` | the current year, in `LICENSE` |
| `<VERIFY_COMMAND>` / `<TEST_COMMAND>` / `<DEPLOY_COMMAND>` | from the profile's ` ```profile ` metadata block; `n/a` where the type has none |

## Markers

`files/CLAUDE.md` carries three substitution markers, each replaced with the body of a profile file:

| Marker | Replaced with |
|---|---|
| `<!-- profile:constraints -->` | `claude-md-fragment.md` |
| `<!-- profile:routing -->` | `skill-routing.md` |
| `<!-- profile:context -->` | `context-rules.md` |
