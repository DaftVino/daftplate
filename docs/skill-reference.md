# Skill reference

daftplate ships two kinds of Claude Code skill. **User-level skills** live under
`skills/` in this repo and are installed to `~/.claude/skills/` by
`scripts/install-skills.mjs` (see ADR 0002) — they are available in every
session on the machine, independent of which repo is open. **Repo-scoped
skills** are not installed globally at all: they ship as files inside a
profile overlay (here, `app-monolith`) and land in a scaffolded repo's own
`.claude/skills/` only when that profile is chosen, so they exist only in the
repos that need them.

## User-level skills

### brief

**Purpose:** Toggle terse output mode for the session — lead with the result, cut anything that doesn't change what the user does next.

**Invocation:** `/brief` to turn on, `/brief off` to turn off. Also triggers on "brief mode", "be terse", "less preamble".

**Inputs / outputs:** No file I/O. Reads nothing; produces a one-line acknowledgment of the toggle, then shapes all subsequent output for the session.

**Failure modes:** None in the sense of missing input — it's a pure behavior toggle (`allowed-tools: []`). Three things override it regardless of state: an explicit request for detail (for that answer only), safety-critical warnings, and pipeline gates (plan review, TDD, ship pipeline are never shortened).

**daftkit disposition:** v1.0 portable

### code-map

**Purpose:** Generate or refresh `docs/code-map.md`, a greppable symbol index with line anchors, so large source files are read in slices instead of whole.

**Invocation:** "code map", "refresh the map", "index this repo", or when a file is too large to open.

**Inputs / outputs:** Reads the target repo's `.js`/`.mjs`/`.cjs`/`.gs`/`.ts`/`.tsx`/`.jsx`/`.html` files of at least 2KB via `node $TEMPLATES/scripts/code-map.mjs <repo>` (flags `--min-bytes`, `--out`). Overwrites `docs/code-map.md` wholesale as generated output.

**Failure modes:** The scanner is a regex pass, not a parser, and is built to miss rather than to guess — a missed symbol is recoverable with `Grep`, but an anchor pointing at the wrong line is a bug to report, not work around. The map's header names the commit indexed source was at; if source has since changed, the map is stale and must be flagged rather than trusted — regenerate only when asked, never as a side effect of reading it.

**daftkit disposition:** deferred to v1.1 (needs script vendoring)

### continuum

**Purpose:** Hand the current chat off and write the prompt that forces the next one's first moves. Delegates the exit note to `/handoff` whole; owns only the next-session prompt and the gate that refuses it.

**Invocation:** `/continuum`, "handoff and start a fresh chat", "I'm going to clear", "write the prompt for the next session", "next session prompt", or "pick up the next task".

**Inputs / outputs:** Invokes `/handoff` first, then assembles a six-section prompt (`Start here`, `Read first`, `Branch`, `Constraints`, `Exit criteria`, `Unknowns and risks`) from real repo state — `git branch`, the code map's staleness, `git status --porcelain` — and runs it through `skills/continuum/scripts/validate-prompt.mjs` before anything reaches disk. A valid prompt is written to `docs/designs/next-session-prompt.md`, printed verbatim, and committed.

**Failure modes:** Three terminal states, and only three. `CONTINUUM_BLOCKED_VALIDATION` — still invalid after one regeneration; writes and commits nothing, prints the violations for manual repair. `CONTINUUM_UNCOMMITTED` — valid, on disk and already printed, but the commit failed; deliberately neither blocked nor success, since the file exists but a `/clear` plus a branch switch would lose it. `CONTINUUM_COMMITTED` — the clean exit. A fourth path is not a terminal state at all: if `/handoff` fails in a way the skill could not work around, it stops and reports rather than generating a prompt — a prompt pointing at a note nobody wrote is worse than no prompt.

**daftkit disposition:** v1.2 portable

### crit

**Purpose:** Design critique that cannot file a judgement it did not look at. Owns an evidence manifest and five checks that exist nowhere upstream; delegates the canonical critique doctrine to `impeccable`'s `critique` playbook by reference rather than restating it.

**Invocation:** `/crit`, "critique this design", "is this generic", "does this look templated", or a request for an identity/craft judgement that has to be evidenced rather than asserted.

**Inputs / outputs:** Probes for `~/.claude/skills/impeccable/reference/critique.md` and **reads** it — invoking `impeccable` by name is not loading its playbook, and that conflation is the measured failure this skill exists to stop. Then P0 preflight (stop rule, evidence plan, reversal cost, and the five-axis triage shared with `/deliberate`), and L1 derived identity, L2 layered taxonomy and P4 restraint *inside* the playbook's Assessment A — not as separate agents, since these are rules rather than conflicting values. Writes `{ manifest, findings }` to `.crit/evidence.json` and runs the bundled `scripts/manifest.mjs`: exit 0 clean, 1 for refusals or an incomplete trail, 2 for an unusable file. Any `⚠️ DEGRADED` banner the validator emits becomes the report's first line.

**Failure modes:** An appearance finding with no rendering is **refused**, not caveated; so is a comparative appearance claim without the variants it compares, and a finding that states no `kind` — the gate fails closed, so relabelling an appearance claim as structural to slip past it has to be typed deliberately. Non-perceptual findings (spec contradictions, accessibility violations, structural defects) pass through untouched and ship even when visual review is blocked. A missing detector or daftplate-owned check **degrades** the run and never refuses a finding; a `non-viewable` classification is accepted only with a stated justification, and then admits appearance findings while still degrading the run. One honest gap: with the playbook absent but a rendering in hand the validator exits 0 with a banner — preventing a chair from *skipping* step 0 is not something a SKILL.md can do, which is what the hook is for. That hook (`~/.claude/crit-report-gate.mjs`, registered user-level on `Stop`) blocks a session that invoked `/crit` and finished without a **complete** manifest; it calls `validateManifest`, so findings are not in its input and it cannot rule on a judgement even by accident. It detects the run by parsing specific transcript fields, never by matching substrings — a session that merely *writes about* crit contains every marker, and three successive regex attempts each blocked the session that wrote them.

**daftkit disposition:** held (3–0 in both panel rounds — needs an explicit dependency manifest, startup validation, and a tested degraded mode)

### curious

**Purpose:** Dial clarifying-question frequency moderately above default for the session — noticeably more, not maximal.

**Invocation:** `/curious` to turn on, `/curious off` to restore default. Also triggers on "ask me more", "check with me more often".

**Inputs / outputs:** No file I/O beyond reading repo docs (CLAUDE.md, `engineering-standards/`, ADRs) to check whether a question is already answered there. Produces one extra clarifying question per task, roughly — not an interrogation.

**Failure modes:** Does not ask about anything the codebase, CLAUDE.md, an ADR, or the conversation already answers — doing so is treated as the dial misfiring, not something the skill can be blamed on. Does not weaken any gate: plan review, TDD, and the ship pipeline are unaffected whether it's on or off.

**daftkit disposition:** v1.0 portable

### deliberate

**Purpose:** Convene three Codex reviewer archetypes (native, veteran, aesthete) with incompatible priorities to argue a contested plan, spec, or design; the calling agent chairs and resolves.

**Invocation:** `/deliberate`, "convene the panel", "argue this out", or a request for deep multi-perspective review of a decision.

**Inputs / outputs:** Takes a preflight (five-axis entry test, stop rule, evidence plan, reversal cost), then a neutral one-paragraph topic framing plus the relevant plan/code inline (Codex cannot read repo files itself). Uses `buildPrompt`/`buildTargetedPrompt`/`nextAction` from `$TEMPLATES/scripts/deliberate.mjs`, piping each round's prompt to `codex exec -s read-only` via stdin. Round 1 is full and blind; round 2 is a targeted dispute round on the live disputes only. Produces a chaired resolution: the named disagreement, per-archetype verdict, one approval-altitude question via `AskUserQuestion`, and a cost report (rounds, model tier, executor, real cost).

**Failure modes:** Codex cannot spawn its own file reader on this machine (`CreateProcessAsUserW failed: 5`) and rejects large prompts passed as arguments (`Argument list too long`) — everything must go in via stdin. `isLooping` compares stance labels with strict equality, so raw model answers never match and loop detection silently never fires unless the chair first canonicalizes each round to a short label (e.g. `'build-reduced'`). If the topic isn't actually contested, the skill says so and declines to convene rather than manufacture disagreement. Three failures are recorded from a measured 611k-token run: a re-filing round 2 costs more than round 1 and returns a fraction of the value; agreement in round 1 is corroboration, not convergence, and triggering resolution from it leaves completeness untested; and a panel judging a visual artifact from source code speculates — hence the mandatory rendered evidence before the final dispute.

**daftkit disposition:** deferred to v1.1 (needs script vendoring)

### gas-deploy

**Purpose:** Deploy a Google Apps Script web app with clasp, avoiding the four recurring traps: `/exec` vs `/dev`, deployment-ID drift, stale deployment accumulation, and account/cache confusion.

**Invocation:** "deploy", "push to Apps Script", "clasp deploy", or naming a gas-webapp project.

**Inputs / outputs:** Reads the repo's `docs/deploy-runbook.md` first (deployment IDs, script ID; wins over this skill's generic guidance on conflict) and runs `clasp push` / `clasp deploy -i <id>` / `clasp deployments`. Produces a verified `/exec` URL, an updated `CHANGELOG.md` Unreleased entry, and an updated runbook if any ID changed.

**Failure modes:** If `clasp` isn't on `PATH`, stops and reports the install command rather than installing it. Deploying without `-i` silently creates a new deployment and a new `/exec` URL, leaving every previously shared link on stale code. Undeploying the live deployment ID takes the app down and cannot be undone from the CLI — `clasp deployments` must be checked first. Testing on `/dev` and announcing `/exec` is called out as the most common false "it works"; a `clasp deploy` exit code alone is never reported as success. Confirms with the user before the first deploy of every session.

**daftkit disposition:** v1.0 portable

### handoff

**Purpose:** Write a session handoff note — branch, plan step, next actions, files-to-read manifest — at the end of a phase.

**Invocation:** "handoff", "wrap up", or a phase is complete.

**Inputs / outputs:** Appends one dated `###` entry to the governing plan document's `## Handoff log` (`docs/designs/YYYY-MM-DD-slug.md`), covering branch/merge state, what shipped, what the plan got wrong (marked **do not revert**), what was discovered, what's still open, and the next phase's read manifest. Also runs gstack `/context-save` and commits the note.

**Failure modes:** If the work has no plan document because none was needed, says so and writes the state into the PR description instead — never creates a design doc solely to hold a handoff. Commits the note even when nothing else is ready to commit, since an uncommitted handoff note doesn't count as one.

**daftkit disposition:** v1.0 portable

### insist

**Purpose:** Hard-gate every `AskUserQuestion` so it is answered by the user, never auto-decided, regardless of auto-approve settings.

**Invocation:** `/insist`, "insist", "stop auto-deciding", "ask me properly"; `/insist off` to release the gate.

**Inputs / outputs:** Writes `on`/`off` to `~/.daftplate/insist` (creating `~/.daftplate/` if absent). Enforcement is a companion `PreToolUse` hook at `.claude/question-gate.mjs` registered in `.claude/settings.json`. While on: states the full question, every option with its trade-off, a recommendation, then stops the turn for the user's answer.

**Failure modes:** If the hook isn't registered in `settings.json`, the skill degrades to a preference — exactly what auto-decide overrides — and must say so rather than claim the gate is active. It also cannot fire on a question never asked: a silent judgment call produces no tool call and no hook trigger, which is why stating the question in full and stopping is the substance of the skill, not the hook itself.

**daftkit disposition:** v1.0 portable

### new-project

**Purpose:** Scaffold a standards-compliant repository of a known type by composing the `base/` layer with one profile overlay.

**Invocation:** "new project", "start a project", "scaffold a repo", or naming a profile type (e.g. gas-webapp, web-app, userscript, local-tool, design-vault, content-library, office-automation).

**Inputs / outputs:** Collects type/name/summary via `AskUserQuestion`, reads `$TEMPLATES/profiles/<type>/profile.md`, and runs `scripts/scaffold.mjs`. Produces a scaffolded repo at `x:\Projects\<name>` with `.daftplate.json` provenance, an initial git commit, `setup-repo.mjs` bootstrap, optional GitHub remote/project board, an ADR 0001 where warranted, and a repo-standards §9 checklist report.

**Failure modes:** Stops without improvising if `$TEMPLATES` doesn't exist, or if the destination directory exists with content. `scaffold.mjs` exit 1 prints each violation (`placeholders` = unfilled token, `collision` = base and profile both writing a file) — the fix is to correct the template and rerun, never hand-patch the scaffolded output. `setup-repo.mjs` never installs a missing tool itself, only reports the install command. GitHub-side protections (secret scanning, branch rules) report as "unavailable" rather than failing silently on private/free-tier repos.

**daftkit disposition:** daftplate-only (the scaffolding engine)

### orient

**Purpose:** Produce a short (<30-line, <15k-token) session-start brief on a repo's current state.

**Invocation:** Start of a session, after `/clear`, or "orient", "where are we", "catch up".

**Inputs / outputs:** Reads `CLAUDE.md`, `.daftplate.json`, `docs/code-map.md` headers, the top `CHANGELOG.md` entry, `git status`/`git log`, `gh issue list`, and the newest `docs/designs/` file's Handoff log. Emits a fixed-section brief: Repo, State, Open work, Last handoff, Watch out, Suggested next action — then stops without starting work.

**Failure modes:** No-ops (skips the brief entirely) when the session opens with a concrete, self-contained task, since running it there is pure overhead. Skips `gh issue list` without comment if `gh` is unavailable or there's no remote. If `docs/code-map.md`'s commit stamp doesn't match the latest commit touching indexed source, reports the drift count instead of trusting the map, and never regenerates it unasked. If the map is absent and a source file exceeds 100KB, says so and offers `/code-map` rather than generating it.

**daftkit disposition:** v1.0 portable

## Repo-scoped skills (app-monolith)

These five ship inside the `app-monolith` profile's files and land in a scaffolded repo's own `.claude/skills/` — they are never installed to `~/.claude/skills/` and exist only in repos built from that profile.

### architecture-audit

**Purpose:** Read-only drift audit of a diff, branch, or domain — cross-domain writes, stale diagrams/ERDs, missing flow docs, and unrecorded ADR-worthy decisions.

**Invocation:** Pre-ship, or "architecture audit", "check for drift", "did the docs keep up".

**Inputs / outputs:** Scopes to the current branch's diff against `main` (or a user-specified domain/directory) and reads domain docs, ERDs, and flow docs. Produces a severity-ranked report — blocking / recommended / polish — with file-level findings and which skill (`architecture-docs`, `domain-module`, `database-schema`, `feature-flow`) fixes each one.

**Failure modes:** Never edits anything — its value is that it is read-only and its report is trusted because of that. Leads with blocking findings; if there are none, states plainly that the audit is clean rather than omitting the line.

**daftkit disposition:** repo-scoped (app-monolith only)

### architecture-docs

**Purpose:** Maintain small, linked C4-style Mermaid architecture views (system-context, container, domain-map, and optional per-container component views) under `docs/architecture/`.

**Invocation:** The system's shape changes, a container is added, or "architecture doc", "C4", "update the diagram".

**Inputs / outputs:** Reads the change that altered the system's shape. Produces or updates one or two Mermaid view files plus the `overview.md` index — never a whole-system master diagram, which is deliberately omitted.

**Failure modes:** A view that disagrees with `src/` is treated as a bug to fix in the same PR, never deferred. Component views are added only where complexity justifies one — most containers never get one, and the report must justify any that were added. A view that now disagrees with another view is surfaced as an `architecture-audit` finding rather than silently reconciled.

**daftkit disposition:** repo-scoped (app-monolith only)

### database-schema

**Purpose:** Change the schema through additive, reversible migrations with a risk checklist, keeping `docs/database/database.dbml` and per-domain ERDs current.

**Invocation:** Adding or altering tables, writing a migration, or "schema", "migration", "ERD", "database".

**Inputs / outputs:** Reads the existing migrations and committed schema (the sole authority). Produces a new migration with a down path, a regenerated `database.dbml` (never hand-edited to change the schema), an updated domain ERD, and PR-description answers to an eight-item risk checklist (keys, nullability, constraints, indexes, cascades, backfill, concurrency, auditability).

**Failure modes:** A destructive, irreversible migration is treated as an exception that needs an ADR, not a default path. A migrated table whose owning domain is unclear is flagged explicitly rather than assigned silently.

**daftkit disposition:** repo-scoped (app-monolith only)

### domain-module

**Purpose:** Create or revise a domain doc (purpose, non-responsibilities, owned tables, public interface, events, dependencies, invariants) and enforce that a domain owns writes to only its own tables.

**Invocation:** Adding or changing a domain, or "domain", "module boundary", "who owns this table".

**Inputs / outputs:** Reads the domain doc beside the domain's `src/` tree. Produces an updated doc, with any cross-domain write found routed through the owning domain's public interface or an event instead of extended silently.

**Failure modes:** A table with no clear owner is raised as an open design question, never left ambiguous. Two domains claiming write-ownership of the same table is treated as the specific failure this skill exists to prevent, and is called out explicitly rather than resolved by convention.

**daftkit disposition:** repo-scoped (app-monolith only)

### feature-flow

**Purpose:** Document one high-impact operation as a Mermaid sequence or state diagram under `docs/architecture/flows/` — trigger, domain-tagged state changes, transaction boundaries, idempotency, failure and compensation.

**Invocation:** A critical operation's behavior changes, or "flow", "sequence diagram", "how does X work end to end".

**Inputs / outputs:** Reads the operation's trigger, preconditions, and cross-domain state changes. Produces one flow file covering trigger/preconditions, state changes tagged with the owning domain, transaction boundaries, idempotency key and replay behavior, failure/compensation, and links to the domains, ERDs, and ADRs it depends on.

**Failure modes:** A plain CRUD endpoint inside a single domain is judged not to warrant a flow doc — the skill says so and stops rather than writing one anyway. A transaction boundary or compensation path the code doesn't actually implement yet is reported as a finding (a documented-but-unbuilt guarantee), not passed over as complete.

**daftkit disposition:** repo-scoped (app-monolith only)

## Summary table

| Skill | Kind | One-line purpose | daftkit disposition |
|---|---|---|---|
| brief | user-level | Toggle terse, result-first output for the session | v1.0 portable |
| code-map | user-level | Generate a line-anchored symbol index so large files are read in slices | deferred to v1.1 (needs script vendoring) |
| continuum | user-level | Hand the chat off and write the validated prompt the next one starts from | v1.2 portable |
| crit | user-level | Design critique that refuses any appearance finding nobody rendered | held (needs a dependency manifest, startup validation, tested degraded mode) |
| curious | user-level | Dial clarifying-question frequency moderately above default | v1.0 portable |
| deliberate | user-level | Argue a contested plan/design through three Codex archetypes, chaired by the agent | deferred to v1.1 (needs script vendoring) |
| gas-deploy | user-level | Deploy a Google Apps Script web app via clasp, avoiding ID and `/exec`-vs-`/dev` traps | v1.0 portable |
| handoff | user-level | Write a durable session handoff note at phase end | v1.0 portable |
| insist | user-level | Hard-gate every user question so it's answered by the user, never auto-decided | v1.0 portable |
| new-project | user-level | Scaffold a standards-compliant repo from base + one profile overlay | daftplate-only (the scaffolding engine) |
| orient | user-level | Emit a short session-start brief on repo state | v1.0 portable |
| diagram | user-level | Analyze a repo through a lens and render an editable `.excalidraw` (structure working board / flowchart / ER / sequence) | v1.1 portable |
| architecture-audit | repo-scoped (app-monolith) | Read-only drift audit of docs against the code | repo-scoped (app-monolith only) |
| architecture-docs | repo-scoped (app-monolith) | Maintain small, linked C4-style Mermaid architecture views | repo-scoped (app-monolith only) |
| database-schema | repo-scoped (app-monolith) | Migrate the schema additively and keep the DBML/ERDs current | repo-scoped (app-monolith only) |
| domain-module | repo-scoped (app-monolith) | Define a domain's ownership contract and enforce single-writer tables | repo-scoped (app-monolith only) |
| feature-flow | repo-scoped (app-monolith) | Document one high-impact, cross-domain operation as a sequence/state diagram | repo-scoped (app-monolith only) |
