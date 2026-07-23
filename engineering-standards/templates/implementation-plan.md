# <Feature> Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use `- [ ]` for tracking.

**Goal:** <one sentence>

**Architecture:** <2–3 sentences on the approach>

**Tech Stack:** <key technologies>

---

## Global Constraints

<Project-wide requirements — version floors, dependency limits, naming rules,
platform requirements. One line each, values copied verbatim from the spec.
Every task's requirements implicitly include this section.>

---

## Phase manifest

**Required.** A plan without this table fails `/plan-eng-review`.

Estimated context is `sum(files-to-read) + 3× that for working churn`. If a row
exceeds ~150k, split the phase at a real seam and add a row.

| Phase | Deliverable | Files to read | Bytes | Est. context | Exit criteria |
|---|---|---|---|---|---|
| 1 | <what ships> | <exact paths> | <sum> | <4× sum> | <observable, testable> |

State the dependency order between phases explicitly — as a list or a diagram.
Phases with no edge between them may be worked in parallel worktrees.

---

## Phase 1 — <name>

**Branch:** `type/short-slug`

### Task 1.1: <component>

**Files:**
- Create: `exact/path`
- Modify: `exact/path:LINES`
- Test: `tests/exact/path.test.mjs`

**Interfaces:**
- Consumes: <exact signatures from earlier tasks>
- Produces: <exact names and types later tasks rely on>

- [ ] **Step 1: Write the failing test** — actual test code, not a description
- [ ] **Step 2: Run it and watch it fail** — exact command, expected failure text
- [ ] **Step 3: Write the minimal implementation** — actual code
- [ ] **Step 4: Run it and watch it pass** — exact command, expected output
- [ ] **Step 5: Commit** — exact `git add` and `git commit -m`

---

## Handoff log

<!-- One entry per phase, appended at phase end. Record: branch and what
     merged; what the plan got wrong and was corrected during execution
     (marked "do not revert"); anything discovered that the next phase needs;
     what is still open and who it needs. Next phase and its read manifest. -->
