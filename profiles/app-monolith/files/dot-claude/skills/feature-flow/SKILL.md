---
name: feature-flow
description: Document one high-impact operation as a Mermaid sequence or state doc under docs/architecture/flows/ — trigger, state changes with owning domain, transaction boundaries, idempotency, failure and compensation. Use when a critical operation's behaviour changes, or the user says "flow", "sequence diagram", "how does X work end to end".
allowed-tools:
  - Read
  - Grep
  - Edit
  - Write
---

# feature-flow

One file per high-impact operation under `docs/architecture/flows/` — economy
transfers, combat resolution, auth lifecycle, async handoffs. Not every endpoint:
a flow doc earns its place by crossing domains, moving money or state that must
not be lost, or having a failure path that matters. GitHub renders the Mermaid.

## 1. Decide whether it needs a flow

A flow is warranted when the operation crosses a transaction boundary, touches
more than one domain, must be idempotent, or has a compensation path. A plain
CRUD endpoint inside one domain does not need one — say so and stop.

## 2. Write the flow

A Mermaid `sequenceDiagram` (interaction-heavy) or `stateDiagram-v2` (lifecycle-heavy) in `docs/architecture/flows/<operation>.md`, covering:

- **Trigger** and **preconditions**.
- **State changes**, each tagged with the **domain that owns** the write.
- **Transaction boundaries** — what commits together, what does not.
- **Idempotency** — the key, and what a replay does.
- **Failure and compensation** — what rolls back, what is compensated, what is left for a human.
- **Links** to the domains, ERDs, and ADRs it depends on.

## 3. Update when behaviour changes

The flow tracks behaviour, not endpoints. A refactor that leaves behaviour identical does not touch it; a change to what commits with what, or to the compensation path, does — in the same PR.

## 4. Report

Name the flow file, the operation, and the reason it warranted a flow. Call out any transaction boundary or compensation path that the code does not actually implement yet — a documented-but-unbuilt guarantee is a finding, not a doc.
