# Development history

How daftplate was built — the phases, the decisions at each seam, and the metrics that track the work. This is the public account of a private working repo; it records the shape of the build, not its full history.

## The method

Every phase followed the same loop, and the loop is the point:

1. **Plan** — a phased implementation plan, each phase sized to fit a single working session's context budget (~150k tokens) with an explicit files-to-read manifest.
2. **Review** — the plan runs through an engineering review before any code, catching architecture and test gaps while they are still cheap to fix.
3. **Implement** — test-first, one task at a time, ending at "PR open, CI green."
4. **Hand off** — a durable handoff note in the plan document, so the next session resumes without rediscovery.

The repo holds itself to its own rules: zero runtime dependencies, tests on the built-in `node:test` runner, Conventional Commits, and nothing that deletes what it did not create.

## The phases

**Phase 0–1 — foundation and the MVP scaffolder.** The layer model (`base/` + `profiles/<type>/`), the composition and verification scripts, and the first two profiles (a Google Apps Script app and an edge-hosted site). Released as `v0.1.0` with **82 tests**. The core decisions were recorded as ADRs: standards are canonical here and never vendored (ADR 0001), and skills are installed user-level (ADR 0002).

**Phase 2 — the token-efficiency skills.** The skills that make long sessions survivable: a session-start brief (`/orient`), a greppable symbol index for large files (`/code-map`), a session-exit note (`/handoff`), plus deploy, terseness, and question-gating skills, and a three-archetype design-argument tool (`/deliberate`). Provenance (`.daftplate.json`) was adopted and the `copier` templating engine deliberately rejected (ADR 0003). The suite grew the tree to **181 tests**.

**Phase 3 — the five remaining profiles.** A large single-file userscript, a zero-dependency CLI, an Obsidian-style design vault, a validated content library, and an Excel/VBA workbook set — each with the validators or export tooling its shape needs, all self-contained so they work in a scaffolded repo with no daftplate checkout present. **263 tests.**

**Phase 4 — the app-monolith profile and its architecture suite.** A profile for an implemented TypeScript-service-plus-database monolith, shipping five repo-scoped architecture skills (C4 diagrams, domain modules, database schema, feature flows, a drift audit) into the scaffolded repo's own `.claude/skills/` — a deliberate exception to the user-level install rule, because those skills only make sense inside that one project kind. **279 tests.**

**Phase 5 — documentation, publication, and `v1.0.0`.** The documentation suite you are reading, the curated-export script that produces the public repos from an allowlist, and the `v1.0.0` release. Publication is by curated export rather than a visibility flip (ADR 0004), with a curated public history and sanitized decisions (ADR 0005).

## The numbers

| Phase | Profiles | Tests |
|---|---|---|
| 0–1 | 2 | 82 |
| 2 | 2 | 181 |
| 3 | 7 | 263 |
| 4 | 8 | 279 |

Two profiles became eight; eighty-two tests became two hundred seventy-nine — every one on the built-in runner, with no test framework and no runtime dependencies added at any point. The growth is not the headline. The headline is that each of those steps was planned, independently reviewed, and implemented test-first inside a fixed context budget, which is what the whole system exists to make repeatable.
