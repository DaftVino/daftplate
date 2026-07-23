## Repo-specific constraints

1. **The VBA in `vba/` is the reviewable artifact; the `.xlsm` is the binary that carries it.** Run `pwsh -File scripts/export-vba.ps1` before every commit that touched a macro. A workbook committed without its export is a change nobody can read.
2. **The export is one-directional.** `vba/` is generated *from* the workbook. Editing a `.bas` file changes nothing until it is imported back in Excel, by hand, deliberately. Never "fix" a bug by editing the export.
3. **Excel must trust the VBA project object model** or the export silently produces nothing. The Trust Center path, the import procedure, and the never-merge-a-workbook rule are all in `docs/vba-runbook.md` — read it before your first export.
4. **Quote every path.** These folders have spaces and capitals in their names, and an unquoted path fails in a way that looks like a missing file rather than a quoting bug.
