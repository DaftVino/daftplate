---
name: database-schema
description: Change the schema through additive, reversible migrations with a risk checklist, and keep docs/database/database.dbml plus per-domain ERDs current. Migrations and the committed schema are the sole authority. Use when adding or altering tables, writing a migration, or the user says "schema", "migration", "ERD", "database".
allowed-tools:
  - Read
  - Grep
  - Edit
  - Write
---

# database-schema

Migrations and the committed schema are the **only** schema authority. The DBML
in `docs/database/database.dbml` and any ERD describe the schema; they never
define it. Engine-agnostic at the core, Postgres-first.

## 1. Write the migration additively and reversibly

Prefer additive changes: add a column/table/index; backfill; then, in a later
migration once nothing reads the old shape, remove it. Every migration has a
down path. A destructive, irreversible migration is the exception that needs an
ADR, not the default.

## 2. Walk the risk checklist

Before committing a migration, answer each — in the PR description, not in your head:

- **Keys** — primary and foreign keys correct and named?
- **Nullability** — new non-null columns have a default or a backfill?
- **Constraints** — uniqueness, checks — enforced where the invariant lives?
- **Indexes** — every new foreign key and every queried column indexed?
- **Cascades** — delete/update cascades intended, not accidental?
- **Backfill** — existing rows handled, and the backfill itself reversible?
- **Concurrency** — does the migration lock a hot table? Use a concurrent path if so.
- **Auditability** — is the change traceable (created/updated timestamps, soft-delete where the domain needs it)?

## 3. Update the DBML and ERDs

Regenerate `docs/database/database.dbml` from the migrated schema — never hand-edit a table there to *change* the schema. Update the affected domain's `<domain>-erd.md`. Both ship in the same PR as the migration.

## 4. Report

Name the migration, the tables touched, and the checklist items that carried real risk (not the whole list — the ones that mattered). Confirm the down path exists and the DBML/ERD were regenerated. Flag any table you touched whose owning domain (per `domain-module`) is unclear.
