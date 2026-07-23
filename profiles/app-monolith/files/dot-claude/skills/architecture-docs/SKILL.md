---
name: architecture-docs
description: Maintain the repo's C4-style architecture views in Mermaid under docs/architecture/ — system context, container, and domain-map views, small and linked. Use when the system's shape changes, a container is added, or the user says "architecture doc", "C4", "update the diagram".
allowed-tools:
  - Read
  - Grep
  - Edit
  - Write
---

# architecture-docs

The architecture of this repo lives as small, linked Mermaid views under
`docs/architecture/`, indexed by `overview.md`. GitHub renders Mermaid and
`gstack-diagram` edits it, so there is no Structurizr and no new tooling. There
is deliberately **no** whole-system master diagram — it goes stale the day it is
drawn and no one reads it.

## 1. Decide which view changed

A change touches at most one or two views. Match it:

- A new externally-facing actor or system → the **system-context** view (`system-context.md`).
- A new deployable or datastore → the **container** view (`containers.md`).
- A new domain, or a change in who owns what → the **domain-map** view (`domain-map.md`).
- Component-level detail → a component view *only where the complexity justifies it*, named `<container>-components.md`. Most containers never need one.

## 2. Write the Mermaid

One `flowchart` or `graph` per view, in a fenced ` ```mermaid ` block, with a one-paragraph lead saying what the view is for and what it deliberately omits. Keep each view to what fits on a screen; if it does not fit, it is two views. Link to the domain docs and flows it references rather than inlining them.

## 3. Keep it honest

The view describes the code as it is, not as intended. If the change is not yet built, the view does not show it. A view that disagrees with `src/` is a bug — fix the view in the same PR, never leave it for later.

## 4. Ship in the PR

The view ships in the same PR as the architecture change it describes; the review gate checks this. Update `overview.md`'s index if you added a view.

## 5. Report

Name the views you changed and the one-line reason for each. If you added a component view, justify why that container needed one. If a view now disagrees with another (a container that no domain owns), say so — that is a finding for `architecture-audit`, not something to paper over.
