---
name: architecture-audit
description: Read-only drift audit of a diff, branch, or domain — cross-domain write violations, stale diagrams and ERDs, missing flows, ownership changes, and ADR-worthy decisions left unrecorded. Reports blocking / recommended / polish with file-level findings. Use pre-ship, or when the user says "architecture audit", "check for drift", "did the docs keep up".
allowed-tools:
  - Read
  - Grep
  - Bash
---

# architecture-audit

A read-only pass that answers one question: *did the architecture, schema, and
flow docs keep up with the code in this change?* It never edits — it reports, in
the `/qa-only` style, so a human or the authoring skill fixes what it finds. It
runs pre-ship for this profile.

## 1. Scope the audit

Default to the current branch's diff against `main`. The user may scope it to one
domain or one directory instead. Establish the file set before auditing so the
findings are anchored to real paths.

## 2. Check for drift, in order of severity

**Blocking** — the change is unsafe to ship until fixed:

- A **cross-domain write**: a write to a table owned (per its `domain-module` doc) by another domain, not routed through an interface or event.
- A **schema change with no migration**, or a migration whose down path is missing.
- A domain doc, ERD, or flow that now **contradicts the code** in this diff.

**Recommended** — should be fixed but not unsafe:

- A high-impact operation changed with **no `feature-flow` update**.
- A new domain or ownership change with **no domain-doc update**.
- An **ADR-worthy decision** (a new dependency direction, an irreversible migration) left unrecorded.

**Polish** — worth noting, not gating:

- A stale link, an ERD that drifted cosmetically, a view that could be split.

## 3. Report

For each finding: severity, the file and line, what drifted, and which skill fixes it (`architecture-docs`, `domain-module`, `database-schema`, `feature-flow`). Lead with the blocking findings; if there are none, say so in the first line — a clean audit is a valid and common result. Never fix anything here: this skill's whole value is that it is read-only and its report is trusted because of it.
