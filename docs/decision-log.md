# Decision log

A public, sanitized summary of the architectural decisions behind daftplate. The full Architecture Decision Records — with their private context — stay in the private working repo; this is their public-safe face (ADR 0005). Each entry states what was decided and why, and what would justify revisiting it.

## Standards are canonical here (ADR 0001)

**Decided:** the engineering standards live in exactly one place. A repo produced by daftplate gets a one-line pointer to them plus a small quick-reference copy — never a full vendored copy. A verifier fails any produced repo that contains a vendored standards directory.

**Why:** copies drift, and each vendored copy adds a large body of text an agent wanders into, spending its limited context on rules it already has globally. A pointer cannot drift, and the one small quick-reference is cheap enough that its drift does not matter. Revisit only if a repo must routinely be worked on with no access to the canonical source.

## Skills are installed user-level (ADR 0002)

**Decided:** each skill is sourced in this repo and installed into the developer's user-level agent directory. The installer copies over the top and never deletes. Skills that only make sense inside one project kind are the exception — they ship into that project's own repo-scoped directory.

**Why:** the skills that create or orient a project must work from *outside* any single repo, so they cannot be repo-scoped. The no-delete rule is a blast-radius decision: the target directory holds every other skill the developer uses, and an unguarded delete keyed on this repo's contents is not worth the tidiness it would buy.

## Layer propagation stays hand-rolled (ADR 0003)

**Decided:** the scaffolding engine is not replaced by an off-the-shelf templating tool. Its one genuinely missing idea — a committed record of what the template wrote — is adopted as a small provenance file in every produced repo.

**Why:** adopting the external tool would be a rewrite of the working engine to buy one feature, it could not express the two-layer additive-plus-override model, and it would add a new runtime prerequisite for a small need. The provenance file gives precise, non-destructive updates later without a three-way merge, in a hundred dependency-free lines against a known manifest.

## Publication is by curated export (ADR 0004)

**Decided:** the working repo stays private, permanently. Publication copies an allowlisted set of paths into separate public repositories with fresh history — allowlist-first, so a path not named is not exported, and a denylist checked afterward so a future allowlist widening cannot silently include the private design and decision documents.

**Why:** the obvious alternative — flipping the working repo public — would carry its full history and issue history permanently and irreversibly, including references to several private repositories and the working notes around them. Editing before flipping does not help, because the earlier revisions are in the history being published. An allowlist that never names the private material fails closed; redaction fails open.

## A curated portfolio history and sanitized decisions (ADR 0005)

**Decided:** the export carries two additional curated documents — a development history and this sanitized decision log — and lays down fresh, phase-labeled history with its own version tags. The curated-export script is confirmed as the single authoritative publication mechanism for both public repos.

**Why:** the private design documents and decision records are the strongest evidence of process, but they name private work and cannot be published raw. Two hand-authored, private-name-free documents reclaim that evidence safely, and a per-phase commit history preserves the phased discipline that a single squashed commit would hide.
