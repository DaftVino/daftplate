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

### agent-fixer

**Purpose:** State what the delegated fixer *is* and what an unattended run is allowed to do — the publication split, the brief the run composes, and the prohibitions. Deliberately not a trigger: starting, stopping, scheduling and inspecting every agent live in `/daft-agent`, because triggering documented per agent is triggering documented twice and the second copy is the one that goes stale.

**Invocation:** `/agent-fixer`, or a question about what the fixer does, what an unattended run may do on this machine, or why a run refused. Invoking it starts nothing — there is no path from this page to a running agent.

**Inputs / outputs:** Doctrine, not tooling: it reads nothing and writes nothing. What it documents is a two-process split — the **run** in a git worktree of its own, always `acceptEdits`, with `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GH_CONFIG_DIR` all redirected so it may not push or open a pull request; and the **publisher**, in the runner process after the run has exited, holding the operator's own credential and permitted exactly one branch and one draft pull request. The trigger is a label applied to the issue on the board, and the six-step brief the run receives is sourced from a shared brief module rather than restated here, with a test pinning the two lists together.

**Failure modes:** A run refuses by name — the enablement gate, an undeclared or ambiguous board, a missing delegation label (checked for existence, because a list filtered by a label that does not exist exits 0 and empty), an issue already claimed by another run, acceptance criteria that do not exist, three separate isolation outcomes, and no reproduction in the run's own commits. A run never merges, never closes an issue, never deletes what it did not create, never opens more than one draft pull request, and never writes an attribution footer. The page also records one gap rather than implying a gate: the workstation credential carries a scope that can publish file contents to the public internet in a single command without any push, and nothing in the loop refuses that gesture today — so the brief answers it with a reason as well as a rule.

**daftkit disposition:** not portable — it drives a runner script plus five shared library modules that only a daftplate checkout has

### agent-hunter

**Purpose:** State what the five defect-hunting lenses are and what they may do — the finding shape, and why every lens is report-only. Like `/agent-fixer` it is doctrine: `/daft-agent` is the only place a hunt is started.

**Invocation:** `/agent-hunter`, or a question about what the hunters look for, what a finding must contain, why nothing was filed, or what a lens is permitted to do. Triggers nothing.

**Inputs / outputs:** Read-only prose. Each lens invokes a doctrine that already exists — `/investigate`, `/review`, `/audit`, `/cso`, and the export guards — rather than re-deriving one, so a lens's job is selection, scoping and structuring and never judgement about what counts as a defect; the doctrine that answered is validated against the lens that asked. A finding carries the lens, a repo-relative path, the nearest enclosing symbol, a defect class, a severity with its reasoning, and an `evidence` field that is exactly `reproduced` or `reasoned`.

**Failure modes:** Report-only is structural rather than a flag: the permitted-operations list holds three entries and neither creating nor closing an issue is among them, closing is additionally named as never permitted, and neither the hunter script nor its lens module can start a process at all — without one there is no `gh` and so no filing, and a test reads both sources and asserts it. Filing arrives only with a measured precision figure, and no lens has one. A finding is rejected for omitting `evidence`, for claiming `reproduced` with no reproduction, for claiming `reasoned` while attaching evidence anyway, and for an absent `symbol` — `null` is an answer, absent is not. A lens that never ran and a lens that found nothing are reported as different results, and a malformed answer is reported rather than dropped, because precision is measured over exactly that difference. It re-files nothing it has already raised, and names the miss it knows about: a rename or a move defeats a path-and-symbol fingerprint, and the limit is reported rather than engineered around.

**daftkit disposition:** not portable — doctrine for an agent that only the checkout-bound `/daft-agent` can start, so standalone it is a page pointing at a page that is not there; the agent trio travels together or not at all

### anchor

**Purpose:** Turn one specified subject into an evidence-grounded continuation brief and a ready-to-submit `/compact` command, so an unfocused compaction cannot discard the task state needed to continue. Continuation inside the same session — not an archive, and not a handoff to a new one.

**Invocation:** `/anchor <subject, desired outcome, and next step>`, explicitly and only. `disable-model-invocation: true`, so it never fires on its own: compaction timing belongs to the user, and excluding it from discovery also keeps its description out of every session's context.

**Inputs / outputs:** Read-only. Prefers facts already established in the conversation; inspects local state only when the named artifact's current state is uncertain *and* that uncertainty would change the brief — concise git state, or the named PR or issue, through bounded `Bash` grants. Writes no file. Produces one instruction plus one fenced block whose first token is `/compact`.

**Failure modes:** Two by design. An argument missing any of subject, desired outcome or resume point gets one clarification question and nothing else — no repository inspection, no partial anchor, no command; defaulting an omitted scope to "the current task" would preserve the wrong subject. And it cannot execute `/compact` itself, because a skill cannot trigger a built-in command ([upstream request](https://github.com/anthropics/claude-code/issues/77266)); it prints the command and must never claim compaction occurred. Neither `git` nor `gh` is a hard dependency — an unavailable one means preserving the uncertainty, not failing. A genuinely unrelated next task gets `/clear` recommended instead.

**daftkit disposition:** v1.0 portable

### audit

**Purpose:** Audit whether tests actually prove what they claim. Reads raw test bodies and the production code beside them, names a concrete mutant per assertion, and reports which assertions accept it. Supplements `/review` rather than replacing it.

**Invocation:** `/audit <a diff, a branch, or a named test scope>`. Also "are these tests real", "would this test have caught it", "mutation check".

**Inputs / outputs:** Read-only. Consumes a diff or a named scope; produces three sections — Blocking, Citation, and **What holds up**, the last naming the mutants the assertions *do* reject. An audit that reports only failures is indistinguishable from one that looked at nothing.

**Failure modes:** It is model-assisted, not sound analysis, and a subtle tautology can survive it. It may recommend a focused command but may **not** write `Observed red:` unless the failing run happened in the session, and it reports absent historical evidence separately from a semantic tautology, because conflating them inflates the second. With an empty diff it says so and stops rather than auditing the whole suite.

**daftkit disposition:** v1.0 portable

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

### daft-agent

**Purpose:** One screen for every agent in the repository — what each one is, whether it can fire, whether it is on, when it runs, and what is running now. It is the single trigger surface: `/agent-fixer` and `/agent-hunter` hold what each agent *is*, and neither holds a way to start, stop, schedule or inspect one.

**Invocation:** `/daft-agent`, "show me the agents", "turn the hunter on", "schedule the fixer", "run the hunter now", "stop that run", or a question about whether an agent is enabled.

**Inputs / outputs:** Renders the agent menu from a script in the daftplate checkout and prints it **verbatim** — the row numbers are the reply grammar, so a screen that summarised or reordered would make every later instruction address a row the user never saw. Edits accumulate in conversation, preview through a plan pass that writes nothing, and land only on the word `save`; the screen re-renders afterwards because indices move. Run counts and live runs come from the run records rather than from memory, so a run this session did not start still shows. A window is honoured by one Windows scheduled task waking every 15 minutes; the schedule does not encode the window, so one readable file holds the truth.

**Failure modes:** Switching an agent on is the owner-held enablement act, so both plan and apply print every enablement condition and where it stands, verbatim, at the moment of the toggle — enabling over an open condition is permitted, enabling blind is the thing the decision record was written to prevent. `CANNOT FIRE` is not `off`: it means the thing the agent waits for does not exist on this board, and the screen prints the unmet precondition and the act that would close it rather than offering a toggle as the fix. Not every agent takes a window — the hunter declares that no timer can drive it, since it plans invocations for a session to perform, so a window on it is refused at the screen and a sweep that finds one starts nothing. It never edits the agent record files by hand, never deletes a scheduled task it has no record of creating, and never claims a run is stopped because a stop was requested — a stop is a request the run honours, never a delete. One limit is stated every time a task is registered: a task registered without an explicit run-as user runs while the user is logged on, and whether it fires while logged off was never measured and must not be implied.

**daftkit disposition:** not portable — its whole operative body is a checkout script plus one installer call and five runner calls, and daftkit ships no scripts directory, so standalone it installed as a menu whose every row is a command that is not there

### daftplate

**Purpose:** Show every daftplate and daftkit setting on one screen — session toggles, hooks, installed skills, decision records, plugins — and save a batch of edits as one act.

**Invocation:** `/daftplate`, "daftplate config", "show my settings", "what hooks are registered", "turn brief on", "remove a skill", "add an ADR".

**Inputs / outputs:** Runs the config menu script from the daftplate checkout and prints its render verbatim, for the same reason `/daft-agent` does — the numbers are the reply grammar. The script is stateless and **the skill holds the staged edits**, in conversation context; nothing reaches disk until the user types `save`, and `exit` discards. The checkout path comes from the recorded location in the user's global instructions, and if it is not recorded the skill says so and stops rather than reading some other repository's skills and reporting them as the user's.

**Failure modes:** Three refusals, and each is reported and left alone rather than achieved another way: removing a skill daftplate did not install (it names the owning pack and its uninstaller — deleting it by hand instead is exactly what the never-delete rule forbids, so the refusal is the rule working), promoting to global a hook whose command contains a project-directory variable that does not resolve there and would silently never fire, and an index that is not on the current screen. A refusal never stops the rest of a batch. It touches nothing outside its six surfaces — not Claude Code's own settings, not outbox notes, not the repo manifest, not toolchain installs, not any other repository. And it is honest about what a toggle is: the stored value is a default for new sessions, not a live channel into a running one, so writing a toggle here does not make the current session obey it.

**daftkit disposition:** not portable — its menu script reads the checkout's own skills tree and decision records to derive ownership, so standalone it would render an empty screen and report it as the truth about the user's configuration

### deliberate

**Purpose:** Convene three Codex reviewer archetypes (native, veteran, aesthete) with incompatible priorities to argue a contested plan, spec, or design; the calling agent chairs and resolves.

**Invocation:** `/deliberate`, "convene the panel", "argue this out", or a request for deep multi-perspective review of a decision.

**Inputs / outputs:** Takes a preflight (five-axis entry test, stop rule, evidence plan, reversal cost), then a neutral one-paragraph topic framing plus the relevant plan/code inline (Codex cannot read repo files itself). Uses `buildPrompt`/`buildTargetedPrompt`/`nextAction` from `$TEMPLATES/scripts/deliberate.mjs`, piping each round's prompt to `codex exec -s read-only` via stdin. Round 1 is full and blind; round 2 is a targeted dispute round on the live disputes only. Produces a chaired resolution: the named disagreement, per-archetype verdict, one approval-altitude question via `AskUserQuestion`, and a cost report (rounds, model tier, executor, real cost).

**Failure modes:** Codex cannot spawn its own file reader on this machine (`CreateProcessAsUserW failed: 5`) and rejects large prompts passed as arguments (`Argument list too long`) — everything must go in via stdin. `isLooping` compares stance labels with strict equality, so raw model answers never match and loop detection silently never fires unless the chair first canonicalizes each round to a short label (e.g. `'build-reduced'`). If the topic isn't actually contested, the skill says so and declines to convene rather than manufacture disagreement. Three failures are recorded from a measured 611k-token run: a re-filing round 2 costs more than round 1 and returns a fraction of the value; agreement in round 1 is corroboration, not convergence, and triggering resolution from it leaves completeness untested; and a panel judging a visual artifact from source code speculates — hence the mandatory rendered evidence before the final dispute.

**daftkit disposition:** deferred to v1.1 (needs script vendoring)

### diagram

**Purpose:** Read a repo through a chosen lens and produce an editable point-in-time board — a `.excalidraw` file plus a Mermaid source. The structure lens is the distinction: it renders folders as nested frames and *units* as semantic cards, so the deliverable is something the user arranges and keeps rather than a picture regenerated from scratch each time. A raw file listing is never the deliverable — a board where every card says `SKILL.md` is a failed board.

**Invocation:** "diagram", "map this repo", "structure board", "update the board", "refresh the diagram", "show what relies on what", "sequence for X", "visualize the structure".

**Inputs / outputs:** Self-contained — it bundles its own scanner and its own converter beside the skill and calls out to no diagram tooling. The scanner lists files through git (tracked plus untracked, ignore rules respected) and applies depth and per-folder caps; the agent then identifies the card unit, confirms one organization choice with the user, enriches the model, and the converter validates it against the schema for the chosen type before writing the board and its Mermaid companion into the target repo. Four lenses (`structure`, `domain-data`, `process-flow`, `described`) and four output types, chosen independently.

**Failure modes:** It refuses to overwrite an existing board, because the user's layout is the work — an update **merges** instead, matching on a marker every generated element carries rather than on label text, so a renamed card is still the same card. Position, size, frame membership, user recolouring, user-edited labels and anything hand-drawn survive; a unit new in the model lands in an inbox frame rather than being dropped into place, and a unit gone from the model is tinted stale rather than deleted. Element ids are preserved so a hand-drawn arrow still points at the card it was aimed at. Where the merge cannot guarantee that — a board carrying no markers, two elements claiming one marker, a hand-drawn element referencing something the update cannot preserve — it leaves the board untouched, writes the fresh render beside it under a different name, and says why. Diagrams are capped at roughly 40 nodes and it narrows the subsystem rather than emitting a wall. Boards are declared non-authoritative scratch snapshots, and two verified Excalidraw quirks are passed on rather than worked around: dragging a frame moves only its direct members, and the legend swatches have no identity of their own so an arrow bound to one cannot be preserved.

**daftkit disposition:** v1.1 portable

### enroll

**Purpose:** Bring a repository daftplate never scaffolded under management, by composing what the templates would produce today, comparing that against the bytes already in the repo, and recording the result as a new `.daftplate.json`. It creates the manifest `/sync-standards` needs; it is the *start* of management, not the whole of it.

**Invocation:** "enroll this repo", "adopt this repo", "bring this under daftplate", or when `/sync-standards` refuses a repo because it has no manifest.

**Inputs / outputs:** Runs from a daftplate checkout, because it has to compose the real scaffold output, and installs nothing in the target. **It writes exactly one file — the manifest — and no other file in the target is created, modified or deleted.** Every composition input is declared on the command line and never inferred: the profile and the three token values come from the operator, while the verify, test and deploy commands are read from the profile's own description. A dry run is the complete measurement and the same one the write records; the report classifies each candidate path as matched (recorded as managed), diverged (recorded with both digests — measured, not owned), or absent (a report line and no manifest entry), then summarises every other Git-visible path as unmanaged, counted and untouched.

**Failure modes:** It refuses a target that vendors the standards, because the canonical tree is never copied out and a manifest would certify a repo whose pointer is contradicted by a stale snapshot beside it. It also refuses a target that is not the exact root of a Git work tree, one that already has a manifest, one whose manifest exists but cannot be parsed, an unsafe link on a managed path, a target that changed mid-measurement, and a manifest that appeared during the run. It never guesses the profile or the tokens, never writes a repository file, never re-baselines, and does not keep the repo current afterwards. Enrollment is **one-shot**: a second run refuses whether the daftplate version is the same or newer, so a wrong summary value — which makes every token-bearing file read as divergent — is cheap to fix only before the manifest is committed. After that, a separate reconciliation command restates the manifest, naming each ownership change explicitly and refusing any entry that is not reproducible from its own recorded inputs, because restating one that is not would erase whatever else put those bytes there.

**daftkit disposition:** not portable — it runs an enrollment script out of a daftplate checkout to compose the real scaffold output, so it cannot stand alone in a skills-only repo

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

### publish

**Purpose:** Regenerate the public daftplate and daftkit repositories from the private working repo. The exports are **one-directional and curated**: every change is made in the working repo and the public ones are regenerated, never edited directly.

**Invocation:** "publish", "publish the update", "sync the public repos", "update the public export". Run from the working repo's root.

**Inputs / outputs:** Drives the export engine, which selects an allowlist, applies a denylist *after* it, refuses to publish if any exported file names a private repo, and copies into a destination over the top — **never deleting**. Four gates before anything public moves: a clean tree on the default branch with a green suite; a dry run whose file list a human reads, which deliberately makes its network call so a real run's refusal is never a surprise; an independent secret scan over a real temp export; and a build of the export into a temp directory where its own suite is run. Updating an existing public repo goes through a pull request, since their default branches are protected. The report states which repo was updated, the file count, the pull request URL, and confirms each gate.

**Failure modes:** The private-name scan is case-insensitive over both paths and content, and a hit stops the publish — the fix is to genericize the reference in the source and improve the public artifact, never to weaken or skip the scan, which is the one guard between the private repo and the public internet. A released version that is tagged but has no published GitHub Release refuses a real run; a failure to *query* releases is reported and allowed through, because failing closed applies to a known violation and not to absent evidence, so a clean run there is not proof. The exported suite is the only check that sees what a stranger sees: a static sweep catches a shipped file naming a withheld path, but not a withheld path read inside a function the file merely hands the repo root to. And because the export never deletes, a file removed in the source must be removed by hand in the clone.

**daftkit disposition:** not portable — it is the tool that maintains these exports, so shipping it would make the export re-export, and it holds the private-name list

### standards-change

**Purpose:** The deviation outbox. When a repo **deliberately** breaks a daftplate standard, the reason belongs somewhere a future reader will find it — not in a commit message nobody greps and not in a comment that ages out. It queues a note locally; a later flush turns one note into a daftplate ADR or an issue.

**Invocation:** "standards change", "record a deviation", "we're breaking the standard here", "flush the outbox", or a repo that needs to differ from the standards on purpose. Two halves usually run weeks apart and from different repos: queueing runs from the deviating repo and is cheap, local and offline; flushing runs from the daftplate checkout, once someone is ready to decide.

**Inputs / outputs:** Its bundled script imports Node builtins only, which is a correctness requirement rather than a preference — it runs from repos that have no daftplate checkout, so a shared-module import would throw the first time anyone used it. A note carries a required rule and a required reason, optionally a local decision record in the deviating repo, and reads the profile and daftplate version from the repo manifest when there is one (recorded as null when there is not, so a repo daftplate never scaffolded can still report a deviation). Notes queue under the user's own daftplate directory rather than straight to GitHub, because a note names a private repo and the standard it broke — nothing leaves the machine until a human flushes it. A bare flush lists and moves nothing.

**Failure modes:** **It never deletes a note** — a flush *moves* it to a flushed subdirectory, byte-identical, and only after the ADR file exists on disk or GitHub has returned an issue URL, so a failed flush leaves the note pending, which is the recoverable direction. It never flushes an issue to a public repo; the target is checked for privacy first. It never creates a duplicate: every body carries an outbox ID and creation searches for it first, so a retry after a partial failure files once. It never overwrites an existing ADR, and never flushes the whole queue at once — one note, one decision. Two note formats are counted separately in the listing, because "11 pending" and "11 pending, none of which this tool can flush" are different situations and the first hides the second; a hand-written note flushes only as an issue, never straight to an ADR, since it carries no structured decision inputs and routing it through the ADR path would publish a decision nobody supplied. Any other file extension is named on stderr, left where it is, and fails the listing — a queue the tool cannot fully see is the queue failing at its one job.

**daftkit disposition:** v1.3 portable

### sync-standards

**Purpose:** Push daftplate template changes into a repo it already produced, without ever overwriting work the repo did. It uses the committed manifest to tell *"the repo changed this file"* from *"the template changed this file"* — the first is reported and never touched, the second is the only thing it writes.

**Invocation:** "sync standards", "update from the template", "pull the latest scaffolding", or after a base-layer file changes and existing repos should pick it up.

**Inputs / outputs:** Runs from a daftplate checkout, because it has to compose what the template would produce today, and is never installed in the target. Preconditions are a committed manifest, a clean working tree in the target, and a branch that is not its default. A dry run comes first and is the only place refusals are explained; each report line is one path and one decision, across a fixed vocabulary — current, updated, refused (modified, overridden, collision, vanished, unsafe link), missing, new, declined, diverged, retained, and the rebaseline states. Adds, restores and declines each require the path to be named. Machine-readable output and per-path diffs are both opt-in, the diff deliberately per path rather than a whole-run switch, so asking for one comparison does not put every managed file's contents into a log that retains it.

**Failure modes:** **It never deletes**, and it never touches a file whose digest does not match the manifest even when that file happens to equal what the template would produce today — matching bytes are not evidence of where they came from. There is no bulk add, restore, decline or rebaseline, on purpose: each expands what the manifest claims daftplate owns or asserts about operator intent, and a bulk flag would make that not-a-decision. A selector matching nothing refuses the whole run and names the status the path actually got, because it used to be a silent no-op that read exactly like naming five paths correctly. A separate command records what is already measurably true for the one state an ordinary run can never leave — a path whose bytes already equal the template's while the manifest records a different digest, which is where restoring from Git leaves you — and it writes no repository bytes at all, refusing every row where the two still differ. A part-way failure **rolls back** newest first, re-proving containment and that the digest is still the one this run wrote; a path something else changed is left as found, never overwritten, and the run fails naming the original failure, each refusal, and a retained staging directory holding the only copies of what it could not restore. That is rollback-safe, not atomic: it does not survive the process being killed between two writes and cannot win a race against another writer. One historical corruption is documented with its repair — a repo scaffolded before the manifest carried a token map had nothing to compose from, so the literal word `undefined` was written into every token-bearing file and then recorded as the new digest, making the next run report the repo current. Sync now refuses before it composes.

**daftkit disposition:** not portable — the propagation half of the scaffolding engine rather than a portable skill; it runs a script from a daftplate checkout and has to compose the current template tree to work at all, so a standalone install would arrive pointing at a checkout that is not there

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
| agent-fixer | user-level | Doctrine for the delegated fixer — the publication split and what an unattended run may not do | not portable (drives a runner and library modules only a checkout has) |
| agent-hunter | user-level | Doctrine for the five defect lenses — the finding shape, and why every lens is report-only | not portable (doctrine for an agent only the checkout-bound `/daft-agent` starts) |
| anchor | user-level | Prepare a continuation brief and the `/compact` command that preserves it | v1.0 portable |
| audit | user-level | Check whether tests reject a named mutant, or merely execute | v1.0 portable |
| brief | user-level | Toggle terse, result-first output for the session | v1.0 portable |
| code-map | user-level | Generate a line-anchored symbol index so large files are read in slices | deferred to v1.1 (needs script vendoring) |
| continuum | user-level | Hand the chat off and write the validated prompt the next one starts from | v1.2 portable |
| crit | user-level | Design critique that refuses any appearance finding nobody rendered | held (needs a dependency manifest, startup validation, tested degraded mode) |
| curious | user-level | Dial clarifying-question frequency moderately above default | v1.0 portable |
| daft-agent | user-level | One screen that starts, stops, schedules and inspects every agent in the repo | not portable (a checkout script plus runner calls daftkit has no scripts for) |
| daftplate | user-level | Show every daftplate/daftkit setting on one screen and save a batch of edits | not portable (its menu derives ownership from the checkout's own tree) |
| deliberate | user-level | Argue a contested plan/design through three Codex archetypes, chaired by the agent | deferred to v1.1 (needs script vendoring) |
| diagram | user-level | Analyze a repo through a lens and render an editable `.excalidraw` (structure working board / flowchart / ER / sequence) | v1.1 portable |
| enroll | user-level | Measure an existing repo against the real scaffold output and record it as a manifest | not portable (composes scaffold output from a daftplate checkout) |
| gas-deploy | user-level | Deploy a Google Apps Script web app via clasp, avoiding ID and `/exec`-vs-`/dev` traps | v1.0 portable |
| handoff | user-level | Write a durable session handoff note at phase end | v1.0 portable |
| insist | user-level | Hard-gate every user question so it's answered by the user, never auto-decided | v1.0 portable |
| new-project | user-level | Scaffold a standards-compliant repo from base + one profile overlay | daftplate-only (the scaffolding engine) |
| orient | user-level | Emit a short session-start brief on repo state | v1.0 portable |
| publish | user-level | Regenerate the public curated exports from the private working repo | not portable (shipping the publisher would make the export re-export) |
| standards-change | user-level | Queue a deliberate standards deviation, and later flush it into an ADR or an issue | v1.3 portable |
| sync-standards | user-level | Push template changes into a repo daftplate produced, never over the repo's own work | not portable (composes the current template tree from a checkout) |
| architecture-audit | repo-scoped (app-monolith) | Read-only drift audit of docs against the code | repo-scoped (app-monolith only) |
| architecture-docs | repo-scoped (app-monolith) | Maintain small, linked C4-style Mermaid architecture views | repo-scoped (app-monolith only) |
| database-schema | repo-scoped (app-monolith) | Migrate the schema additively and keep the DBML/ERDs current | repo-scoped (app-monolith only) |
| domain-module | repo-scoped (app-monolith) | Define a domain's ownership contract and enforce single-writer tables | repo-scoped (app-monolith only) |
| feature-flow | repo-scoped (app-monolith) | Document one high-impact, cross-domain operation as a sequence/state diagram | repo-scoped (app-monolith only) |
