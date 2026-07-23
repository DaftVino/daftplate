---
name: domain-module
description: Create or revise a domain with its required domain doc — purpose, non-responsibilities, owned tables, public interface, events, dependencies, invariants. Enforces that a domain owns writes to its own tables. Use when adding or changing a domain, or the user says "domain", "module boundary", "who owns this table".
allowed-tools:
  - Read
  - Grep
  - Edit
  - Write
---

# domain-module

A domain is a bounded piece of the system with a doc that says what it owns and
what it refuses to own. The doc is the contract; the code conforms to it. These
domain docs double as `/orient`'s preferred context surface — they say *what owns
what*, where `code-map` says *where things are*.

## 1. Write or revise the domain doc

Every domain has a doc (beside its `src/` tree) with exactly these sections:

- **Purpose** — one paragraph.
- **Non-responsibilities** — what this domain deliberately does *not* do. This is what keeps it bounded.
- **Owned entities and tables** — the tables this domain, and only this domain, writes to.
- **Public interface** — the functions/endpoints other domains may call.
- **Events** emitted and consumed.
- **Dependencies** — the other domains it calls, and why.
- **Invariants** — the conditions that must always hold.
- **Links** to ADRs, flows, ERDs, and the tests that enforce the invariants.

## 2. Enforce the ownership rule — a checkable condition

*A domain owns writes to its own tables.* Stated so it can be checked:

> For every table T listed under some domain's **Owned tables**, every write to T
> (INSERT/UPDATE/DELETE, migration aside) originates in that domain's code. A write
> to T from any other domain is a violation.

When a change needs another domain's data changed, it calls that domain's **public interface** or emits an **event** it consumes — never a direct write. When you find a cross-domain write, call it out and route it through the interface; never silently extend it. `architecture-audit` reports these at ship time.

## 3. Keep ownership singular

Two domains claiming write-ownership of one table is the failure this skill exists to prevent. If a table has no clear owner, that is a design question to raise, not a thing to leave ambiguous — an unowned table is a finding.

## 4. Report

Name the domain, the tables it now owns, and any ownership change. List every cross-domain write you found and how you routed it (interface or event). If a table's ownership is contested or absent, say so plainly — that is the highest-value line in the report.
