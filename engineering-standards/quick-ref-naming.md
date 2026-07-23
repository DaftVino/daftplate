# Quick Ref: Naming

**Default rule: `lowercase-kebab-case` for everything.** Exceptions are listed explicitly below.

## Names

| Thing | Pattern | Good | Bad |
|---|---|---|---|
| Repo | `lowercase-kebab` | `my-webapp` | `My-Webapp` |
| Folder | `lowercase-kebab` | `assets/logo/` | `Logo/` |
| Doc file | `lowercase-kebab.md` in `docs/` | `docs/provider-notes.md` | `PROVIDER_NOTES.md` |
| Source file | Language/platform norm | `Code.js`, `utils.js` | `Torn_Bookie_Live_Scores.js` |
| Design doc | `docs/designs/YYYY-MM-DD-slug.md` | `2026-07-01-chunk-registry.md` | `plan_final_v2.md` |
| ADR | `docs/adr/NNNN-slug.md` | `0003-use-properties-service.md` | `decision-about-storage.md` |
| Git tag | `vMAJOR.MINOR.PATCH` | `v2.0.5` | `version-2.0.5`, `2.0.5` |

**Uppercase allowed at root only:** `README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CLAUDE.md`/`AGENTS.md`. Nothing else, nowhere else.

## Branches

Pattern: `type/short-slug` — optionally `type/N-slug` with the issue number.

| Prefix | Use | Example |
|---|---|---|
| `feat/` | New functionality | `feat/esports-provider` |
| `fix/` | Bug fix | `fix/42-registry-cap` |
| `docs/` | Docs only | `docs/setup-guide-rewrite` |
| `refactor/` | No behavior change | `refactor/provider-dispatch` |
| `chore/` | Tooling, deps, CI | `chore/bump-clasp` |
| `test/` | Tests only | `test/alias-matching` |

Slug: 2–5 hyphenated words, no dates, no spaces, no uppercase.

## Commits (Conventional Commits)

Pattern: `type(scope)?: imperative summary` — lowercase, ≤72 chars.

| Element | Rule | Example |
|---|---|---|
| Type | Branch prefixes + `perf`, `style`, `ci` | `fix(sync): …` |
| Summary | Imperative, no period | `add tennis fallback provider` |
| Body | Required when the *why* isn't obvious | free text |
| Issue link | Footer | `Fixes #42` |
| Breaking | `!` after type + footer | `feat!: …` + `BREAKING CHANGE: …` |
