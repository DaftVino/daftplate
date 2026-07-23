## Context budget

- **Never read an `.xlsm`.** It is a binary archive; a `Read` on it wastes the window and returns nothing usable. The `vba/` export is the readable form.
- Read the module you are changing, not the whole export. `docs/code-map.md` (from `/code-map`) indexes `vba/` once it grows past a few files.
- `docs/vba-runbook.md` answers the Excel-side questions once; read it instead of re-deriving the Trust Center path.
- Session start: `/orient`. Phase or session end: `/handoff`.

## Subagent defaults

- "Which macro does X?" → an Explore subagent over `vba/`; take its answer, not its file dumps.
- Repetitive edits across many modules → a cheaper-model subagent, one task per workbook, and remember the edits do not take effect until re-imported.
