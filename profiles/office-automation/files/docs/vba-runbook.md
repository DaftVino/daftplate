# VBA runbook

Excel-side procedures that the export script cannot do for you. `scripts/export-vba.ps1` automates step 2; everything else is manual by nature.

## 1. Enable the export once, per machine

File → Options → Trust Center → Trust Center Settings → Macro Settings → tick **Trust access to the VBA project object model**.

Without it, the COM call that enumerates VBA components fails and the export produces an empty `vba/` directory. It fails *quietly* — an empty export looks like a workbook with no macros. If a module count drops to zero, check this before believing the diff.

## 2. Export before every commit that touched a macro

```
pwsh -File scripts/export-vba.ps1
```

Writes `vba/<workbook>/<module>.bas|.cls|.frm`. Commit the export in the same commit as the `.xlsm`. `pwsh -File scripts/export-vba.ps1 -Check` exits 1 if the export is out of date and writes nothing — that is what `verify:` runs.

## 3. Import a change back into a workbook

There is no scripted path, deliberately. In the VBA editor: right-click the project → Import File, select the `.bas`, and remove the stale module. Then re-export and confirm the diff is empty.

The export is one-directional. A `.bas` edited in a text editor changes nothing until this happens, and a PR that edits `vba/` without touching the `.xlsm` has changed nothing at all.

## 4. When two people edited the same workbook

Git cannot merge an `.xlsm`. Pick one workbook as the survivor, re-apply the other change through the VBA editor, and re-export. The `vba/` diff tells you what the other change *was* — that is what the export is for. A workbook is never merged by git; coordinate first.

## Gotchas

- **A workbook open in Excel is locked**; the export skips it and says so. Close it.
- **Form modules (`.frm`) carry a binary `.frx` sibling** holding the control layout. It is exported alongside and is not diffable; treat a `.frx` change as "the form layout moved" and describe it in the PR.
- **Digital signatures on the VBA project break on import.** Re-sign after any import, or the workbook warns every user.
