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

## ROADMAP.md

`files/ROADMAP.md` ships to every scaffolded repo, but the obligation to keep one
is per-profile: the profile's ` ```profile ` block declares `roadmap: required` or
`roadmap: optional` (repo-standards §6.6). Under `optional`, deleting the file is
a correct first act. Under `required`, it is the repo's only live state document
and `check-roadmap.mjs` holds it to the shape.

Every angle-bracket span in it except `<PROJECT_NAME>` is filled by hand, not by
`scaffold.mjs`. They are lowercase on purpose — `verify-repo.mjs` flags an
uppercase `<LIKE_THIS>` span as an unsubstituted scaffold token, and a template
whose deliberate blanks trip that check would report two violations on every
fresh scaffold.

## Placeholders

`/new-project` replaces these in every copied file via `scripts/scaffold.mjs`. `scripts/verify-repo.mjs` fails any repo where one survives in any text file.

| Placeholder | Filled with |
|---|---|
| `<PROJECT_NAME>` | the repo name, lowercase-kebab |
| `<PROJECT_SUMMARY>` | 2–3 lines: what it is, who uses it, what it runs on |
| `<YEAR>` | the current year, in `LICENSE` |
| `<VERIFY_COMMAND>` / `<TEST_COMMAND>` / `<DEPLOY_COMMAND>` | from the profile's ` ```profile ` metadata block; `n/a` where the type has none |

**A copied template can never show a token in its bracketed form.** Substitution
rewrites `<PROJECT_NAME>` wherever it appears in a file the layers wrote — in a
comment explaining the token exactly as readily as in a line meant to be filled
— and a form that survived substitution would be reported by
`scripts/verify-repo.mjs` as a possible unresolved placeholder, which is the
guarantee that no unfilled token ships and is not negotiable. There is no escape
and none is wanted: name the token bare, as `PROJECT_NAME`, in any comment that
must mention it. This file may quote the bracketed form because it is a layer
manifest and is never copied.

## Markers

`files/CLAUDE.md` carries three substitution markers, each replaced with the body of a profile file:

| Marker | Replaced with |
|---|---|
| `<!-- profile:constraints -->` | `claude-md-fragment.md` |
| `<!-- profile:routing -->` | `skill-routing.md` |
| `<!-- profile:context -->` | `context-rules.md` |
