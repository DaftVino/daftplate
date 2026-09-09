# Profile: office-automation

## When to use

A folder of Excel workbooks whose macros are real software: VBA that runs a payroll, an inventory dashboard, or a reporting pipeline. The `.xlsm` is the artifact; the VBA inside it is the code, and git cannot see it without help. Exemplars: a payroll workbook and an inventory dashboard. First real use-case: a workbook-automation toolkit.

## Stack assumptions

- Excel on Windows, macro-enabled workbooks (`.xlsm`) tracked as binary — `*.xlsm binary` is already in the base `.gitattributes`.
- `scripts/export-vba.ps1` exports every workbook's VBA components to `vba/<workbook>/<module>.bas|.cls|.frm`, which is what actually gets reviewed. PowerShell 7, Excel COM, Windows only.
- Exporting requires Excel's **"Trust access to the VBA project object model"** (File → Options → Trust Center → Trust Center Settings → Macro Settings). Without it the COM call fails and the export is empty, not wrong — check the module count.
- **Existing folders have spaces and capitals in their names** (`Payroll sheet Project`). Every path in a command is quoted. Session 2f lost a whole session to exactly this: `spawnSync` with `shell: true` word-split a path and git exited 128 while the caller recorded `unknown`.

## Metadata

```profile
verify: pwsh -File scripts/export-vba.ps1 -Check
test: n/a
deploy: n/a
docs-subdirs: designs, adr
roadmap: optional
```

## Extra directories

`vba/` appears on the first export. `scripts/export-vba.ps1` and `docs/vba-runbook.md` ship with the profile. Workbooks live at the repo root or in a folder named for their domain.

## Overrides

None. This profile only adds files; `files-override/` is absent. In particular it does **not** override `.gitattributes` — the base layer already marks `*.xlsm` binary, and a second rule saying the same thing is drift waiting to happen.
