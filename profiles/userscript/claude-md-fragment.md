## Repo-specific constraints

1. **The userscript is one large file and must never be read whole.** Grep `docs/code-map.md` for the symbol, then read only the lines around the anchor. A session that opens it wholesale has failed regardless of what it produced.
2. **Selectors against the host site are fragile by nature.** Every DOM query needs a null guard and a visible failure path; a silent `undefined` in a userscript looks like the host site broke. Record the selector's purpose next to it, so the repair is possible when the site changes.
3. **`@version`, the newest `CHANGELOG.md` heading, and the git tag move together in one commit.** Users update by version string; a bumped script with an unbumped header ships invisibly.
4. **`@match`, `@grant`, and `@connect` are the security surface.** Widening any of them needs a stated reason in the PR description. `@grant none` is the default to argue against, not for.
5. **No secret reaches the script.** Everything in a userscript is readable by every user. API keys are entered by the user and held in script storage, never committed — `api-key-setup-readme.md` is the pattern.
