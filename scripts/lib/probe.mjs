// Asking the machine what it has. Lived in setup-repo.mjs until check-machine.mjs
// needed it too — importing it from there would have made the two scripts a
// cycle, since setup-repo now prints check-machine's advisory line.
//
// Nothing here installs, and nothing here writes. Note that a probe is not
// entirely without effect on the machine: `gh --version` makes gh create its own
// state directory. That is the probed tool's doing, not ours, and
// tests/check-machine.test.mjs pins the distinction.
import { spawnSync } from 'node:child_process';

/** True when `<command> <versionArgs>` exits 0. `shell: true` is what lets this
 *  find a .cmd or .ps1 shim on Windows — npm global bins are shims, not .exe
 *  files, so a bare spawn would report an installed tool as missing.
 *
 *  `--version` is the default because almost everything answers it, but it is a
 *  per-tool fact rather than a universal one and was wrong for restic, which
 *  exits 1 with "unknown flag: --version" and wants `restic version`. That
 *  reported an installed tool as missing, and the manifest entry now carries the
 *  form it answers to. */
export function commandExists(command, versionArgs = ['--version']) {
  return spawnSync(command, versionArgs, { shell: true, stdio: 'ignore' }).status === 0;
}
