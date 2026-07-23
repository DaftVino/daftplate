# ADR 0001: docs/architecture/ and docs/database/ are nested doc trees

**Status:** Accepted
**Date:** <YEAR>-01-01

## Context

repo-standards §3 keeps `docs/` flat: every file lowercase-kebab, no subdirectories except `designs/` and `adr/`. An implemented monolith carries more architecture and schema documentation than a flat directory can hold legibly — C4 views, per-domain docs, one flow file per high-impact operation, and an ERD set — and those docs are maintained by dedicated skills that expect stable subtrees.

## Decision

We will allow two nested doc trees in this repo — `docs/architecture/` (with `flows/`) and `docs/database/` — superseding repo-standards §3's flat rule for this profile only. The profile's `docs-subdirs` metadata names them so the verifier's allowlist permits them; every file within stays lowercase-kebab.

## Alternatives considered

- **Keep docs flat, prefix by area** (`architecture-system-context.md`, `database-orders-erd.md`). Rejected: the flat namespace becomes unreadable past a dozen files, and the skills would encode a naming scheme instead of a directory.
- **Push architecture docs out to a wiki or external tool.** Rejected: docs must ship in the same PR as the code they describe and be reviewed as code — an external surface breaks that gate.

## Consequences

Easier: the architecture suite has stable homes to write into, and `/orient` gets a domain-doc surface. Harder: this repo diverges from the flat-docs standard, so a reader must know the deviation is deliberate — hence this ADR. Revisit if repo-standards §3 itself adopts nested trees, at which point this ADR is superseded rather than deleted.
