import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROFILE = join(ROOT, 'profiles', 'office-automation');
const SCRIPT = join(PROFILE, 'files', 'scripts', 'export-vba.ps1');

test('the export script ships in the profile overlay', () => {
  assert.equal(existsSync(SCRIPT), true);
});

test('gitignore-append covers Excel lock files and never the workbooks themselves', () => {
  const lines = readFileSync(join(PROFILE, 'files', 'gitignore-append'), 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  assert.ok(lines.includes('~$*.xlsm'), 'Excel lock files are not ignored');
  assert.equal(lines.some((l) => l === '*.xlsm' || l === '*.xlsx'), false,
    'the workbooks are the product and must stay tracked');
});

test('the profile ships no files-override — base already marks *.xlsm binary', () => {
  assert.equal(existsSync(join(PROFILE, 'files-override')), false);
  assert.match(readFileSync(join(ROOT, 'base', 'files', 'dot-gitattributes'), 'utf8'), /\*\.xlsm binary/);
});

test('the export deletes only extensions it produced, never a hand-authored sibling', () => {
  const src = readFileSync(SCRIPT, 'utf8');

  // No unfiltered removal of everything under the committed directory: that would
  // delete a note, screenshot or README a person put under vba/<workbook>/.
  assert.equal(/\$committed\b[^\n]*-File\s*\|\s*Remove-Item/.test(src), false,
    'unfiltered Remove-Item against $committed would delete files a human added');

  // The removal is scoped to the extensions the script itself writes.
  assert.match(src, /\$Owned\s*=\s*@\([^)]*'\.bas'/);
  assert.match(src, /Where-Object\s*\{\s*\$Owned\s+-contains\s+\$_\.Extension\s*\}/);
});

test('export-vba.ps1 parses under the PowerShell parser', (t) => {
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  if (pwsh.status !== 0) {
    t.skip('pwsh is not on PATH');
    return;
  }

  const command = [
    '$errs = $null;',
    `$null = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/\\/g, '\\\\')}', [ref]$null, [ref]$errs);`,
    'if ($errs.Count) { $errs | ForEach-Object { $_.Message }; exit 1 }',
  ].join(' ');

  const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8' });

  assert.equal(result.status, 0, `parse errors:\n${result.stdout}${result.stderr}`);
});
