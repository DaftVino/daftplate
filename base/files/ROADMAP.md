# ROADMAP

<PROJECT_NAME>'s only live state document (`repo-standards` §6.6). Plans live in
`docs/designs/`; this file is state, not planning. Session handoffs go to issue
comments — never to a file of their own.

Every row in **Now** and **Next** names the evidence that closes it, on the ladder
`specified → unit-tested → persisted → wired → real-provider-proven →
journey-accepted → beta-ready`. Green unit tests close nothing above `unit-tested`.
`scripts/check-roadmap.mjs` enforces that both sections exist, that each carries
the three-column table, that every rung is one of the seven and spelled in
backticks, that no "Closes when" cell is empty, and that exactly one board block
survives. Every other rule on this page is convention, and is marked as such where
it appears. Nothing checks whether a rung is *honest* — a green run proves a rung
was named, never that it was earned (§6.6.1).

There is deliberately no "last updated" line. `git log -1 -- ROADMAP.md` answers
it and cannot go stale, which a hand-stamped date always does.

**Cadence — convention.** Reviewed at weekly triage. **Now** holds at most five
rows; a sixth means something moves to Next or gets cut, not that the cap bends.

<!-- BOARD — keep exactly ONE of the two blocks below and delete the other.
     check-roadmap.mjs fails if more than one line starting `Board:` survives. -->

<!-- Keep this one if work is tracked on GitHub Projects (§6.5, the default). -->
Board: the GitHub Project for this repository. The issue is canonical and the
project is a view of it; where the two disagree, the issue wins. Phases are
Milestones, and each milestone mirrors a section of this file.

<!-- Keep this one INSTEAD if the repo has adopted the Linear variant (§6.5.1),
     which requires its own ADR. Under that variant every issue named in this
     file carries both identifiers, `#N (TEAM-M)`. -->
Board: issues are created in GitHub and managed in Linear (ADR <nnnn>) — the
[<project>](<linear-project-url>) project, team `<team>`. GitHub is canonical for
whether an issue exists; Linear is canonical for its state. Linear milestones
mirror the sections below, verbatim.

## Charter

Delete this section only if the repo has no product surface (§6.6).

- **Target user** — who this is for, specific enough that it excludes someone.
- **The wedge** — what this does that nothing else does, and the evidence for
  that claim. Cite the document.
- **The promise** — one sentence in the user's words. Name what it never claims.
- **Non-goals** — what this deliberately does not do, and what is out of scope
  for the current version.

A plan serving no line above is rejected at review (§6.6).

## Now — <the one outcome this section buys>

| Item | Closes when | Rung |
|---|---|---|
| #N Title | The observable fact that makes this true. | `wired` |

**Blocked or owner-only.** Work that is not code — contracts, account
operations, anything an agent cannot reach. Name it here rather than letting it
sit invisible in the table above.

## Next — <the outcome after that>

| Item | Closes when | Rung |
|---|---|---|
| #N Title | The observable fact that makes this true. | `persisted` |

## Gate — <the decision> (<hard date>)

Optional. Delete it if the repo is not making a bet with a decision point.

Criteria are fixed in an ADR **before** the work they judge ships, so passing the
gate cannot be argued for after the fact. State the criteria, state what happens
on each outcome, and record the outcome as a new ADR either way.

| Week of | <metric> | <metric> | Notes |
|---|---|---|---|
| — | — | — | starts when <the thing being measured> ships |

## Later — <horizon>

Not launch-gating. Grouped by theme, issue numbers only; a row earns a rung by
being promoted to Next, not by sitting here.

- **<theme>** — #N, #N, #N.

## Parked

Each entry names what would reinstate it. An entry with no reinstatement
condition is not parked, it is cancelled — close it.

- #N Title — reinstated by <the condition>.

## Standing gates

These never close. Each names its target, how often it is checked, and the date
it was last actually verified — a gate with no date is a claim, not evidence.
Delete rows that do not apply to this repo; do not delete the section.

| Gate | Target | Cadence | Last verified |
|---|---|---|---|
| Dependency alerts | Dependabot alerts on; zero open critical or high | weekly | — |
| Secret scan | gitleaks green on `main` | every push | — |
| Secret rotation | Every credential in the store rotated | quarterly | — |
| Access review | Admin on repo, hosting and board is the current set of people | semi-annual | — |
| Restore drill | A restore performed from backup into a scratch environment | quarterly | — |
| Rollback path | The last release is revertible by a named command | per release | — |
| Dependency licences | No dependency licence incompatible with `LICENSE` | per release | — |
| Accessibility | WCAG 2.2 Level AA on served output, where this repo serves a UI (§11.1) | per release | — |
| HTML conformance | WHATWG HTML Living Standard, measured on served output with the Nu Html Checker (§11) | per release | — |
| Board dressing | Every open issue carries the board fields its variant requires (§6.5, §6.5.1) | weekly | — |

## Standing decisions

- **ADR NNNN** — one line each, newest first. An ADR that supersedes another
  says so.
- The doc of record is `docs/designs/<the current one>.md`.
- Records in `docs/records/<skill>/` carry the falsifiers that would reopen a
  settled decision. Read the record before re-arguing it.
- Accepted deviations from `repo-standards`, each naming the upstream issue that
  records it, so the deviation is not silent in the repo that has it.
