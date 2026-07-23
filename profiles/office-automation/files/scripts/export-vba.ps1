<#
.SYNOPSIS
    Exports the VBA in every workbook to diffable text under vba/.

.DESCRIPTION
    An .xlsm is a binary archive: git can store it but never show you what
    changed inside it. This writes each workbook's VBA components to
    vba/<workbook>/<module>.<ext> so the macro code reviews like code.

    Requires Excel and "Trust access to the VBA project object model"
    (File > Options > Trust Center > Trust Center Settings > Macro Settings).
    Without it the component enumeration fails and the export is EMPTY rather
    than wrong — see docs/vba-runbook.md.

.PARAMETER Root
    Repository root to scan. Defaults to the current directory.

.PARAMETER Check
    Report whether the export is out of date and write nothing. Exit 1 on drift.
    This is what the profile's verify: command runs.

.EXAMPLE
    pwsh -File scripts/export-vba.ps1
    pwsh -File scripts/export-vba.ps1 -Check
#>
[CmdletBinding()]
param(
    [string] $Root = '.',
    [switch] $Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# vbext_ComponentType -> file extension. 3 (MSForm) also emits a binary .frx
# sibling holding the control layout; Excel writes it alongside on its own.
$Extensions = @{ 1 = '.bas'; 2 = '.cls'; 3 = '.frm'; 100 = '.cls' }

# The extensions THIS script writes. Only these are removed on a re-export; any
# other file under vba/<workbook>/ was put there by a human and is not ours to
# delete (repo-standards / CLAUDE.md: nothing deletes what it did not create).
$Owned = @('.bas', '.cls', '.frm', '.frx')

$RootPath = (Resolve-Path -LiteralPath $Root).Path
$VbaRoot = Join-Path $RootPath 'vba'

$workbooks = @(Get-ChildItem -LiteralPath $RootPath -Recurse -File -Include '*.xlsm', '*.xlsb' |
    Where-Object { $_.FullName -notlike '*\~$*' -and $_.FullName -notlike "$VbaRoot*" })

if ($workbooks.Count -eq 0) {
    Write-Host 'no macro-enabled workbooks found — nothing to export'
    exit 0
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("vba-" + [guid]::NewGuid().ToString('n'))
$null = New-Item -ItemType Directory -Path $staging

$excel = $null
$drift = @()
$exported = 0

try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false

    foreach ($file in $workbooks) {
        $name = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
        $target = Join-Path $staging $name
        $null = New-Item -ItemType Directory -Path $target

        $book = $excel.Workbooks.Open($file.FullName, $false, $true)
        try {
            # Accessing the VBA project is blocked unless "Trust access to the VBA
            # project object model" is enabled. That surfaces as a raw COM error on
            # this property; catch it and fail with the fix rather than the symptom.
            # Failing loudly here is deliberate — silently treating the block as an
            # empty export would let a later replace delete a committed vba/ tree.
            try {
                $components = $book.VBProject.VBComponents
            }
            catch {
                throw "$($file.Name): cannot read the VBA project. Enable Excel > File > Options > Trust Center > Trust Center Settings > Macro Settings > 'Trust access to the VBA project object model' — see docs/vba-runbook.md. ($($_.Exception.Message))"
            }
            if ($components.Count -eq 0) {
                Write-Warning "$($file.Name): no VBA components. If this workbook has macros, Excel is not trusting the VBA project object model — see docs/vba-runbook.md."
            }
            foreach ($component in $components) {
                $extension = $Extensions[[int]$component.Type]
                if (-not $extension) { continue }
                $component.Export((Join-Path $target ($component.Name + $extension)))
                $exported++
            }
        }
        finally {
            $book.Close($false)
        }

        # Compare against what is committed, then either report or replace.
        $committed = Join-Path $VbaRoot $name
        $before = if (Test-Path -LiteralPath $committed) {
            Get-ChildItem -LiteralPath $committed -Recurse -File | Sort-Object Name
        } else { @() }
        $after = Get-ChildItem -LiteralPath $target -Recurse -File | Sort-Object Name

        $changed = ($before.Count -ne $after.Count) -or (@(Compare-Object `
            -ReferenceObject @($before | ForEach-Object { "$($_.Name):" + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) `
            -DifferenceObject @($after | ForEach-Object { "$($_.Name):" + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) `
        ).Count -gt 0)

        if ($changed) { $drift += $name }

        if (-not $Check -and $changed) {
            # Replace only what a previous run of THIS script produced, never a
            # sibling file or directory a human added under vba/<workbook>/.
            if (Test-Path -LiteralPath $committed) {
                Get-ChildItem -LiteralPath $committed -File |
                    Where-Object { $Owned -contains $_.Extension } |
                    Remove-Item -Force
            } else {
                $null = New-Item -ItemType Directory -Path $committed -Force
            }
            Copy-Item -Path (Join-Path $target '*') -Destination $committed -Force
        }
    }
}
finally {
    if ($null -ne $excel) {
        $excel.Quit()
        $null = [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
    }
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}

if ($Check) {
    if ($drift.Count -gt 0) {
        Write-Error "vba/ is out of date for: $($drift -join ', '). Run: pwsh -File scripts/export-vba.ps1"
        exit 1
    }
    Write-Host "clean — $($workbooks.Count) workbook(s), $exported component(s)"
    exit 0
}

Write-Host "exported $exported component(s) from $($workbooks.Count) workbook(s) into vba/"
exit 0
