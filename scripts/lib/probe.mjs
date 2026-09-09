// Asking the machine what it has. Lived in setup-repo.mjs until check-machine.mjs
// needed it too — importing it from there would have made the two scripts a
// cycle, since setup-repo now prints check-machine's advisory line.
//
// Nothing here installs, and nothing here writes. Note that a probe is not
// entirely without effect on the machine: `gh --version` makes gh create its own
// state directory. That is the probed tool's doing, not ours, and
// tests/check-machine.test.mjs pins the distinction.
import { spawnSync } from 'node:child_process';

/** The only shapes this probe will hand to a shell. Node's DEP0190 says an
 *  argument array passed alongside `shell: true` is CONCATENATED, not escaped, so
 *  the shell re-parses the joined line — a token carrying `;`, `&&`, a quote, a
 *  substitution or whitespace would execute. Every name and flag this probe
 *  actually receives comes from a committed manifest and fits this grammar, so
 *  the guard costs nothing real and closes the injection outright. */
const SAFE_TOKEN = /^[A-Za-z0-9._+-]+$/;

/** True when `<command> <versionArgs>` exits 0.
 *
 *  This is the one place `shell: true` is kept, because it is what finds a `.cmd`
 *  or `.ps1` shim on Windows — npm global bins are shims, not `.exe` files, so a
 *  bare spawn reports an installed tool as missing. The **argument array** goes
 *  instead: with a shell, a joined string is what actually runs, so passing the
 *  array was asking Node to build that string without escaping it.
 *
 *  A token outside the grammar returns false rather than throwing. The question
 *  asked is "is this tool present", and a name the probe will not run is not
 *  present as far as any caller is concerned.
 *
 *  `--version` is the default because almost everything answers it, but it is a
 *  per-tool fact rather than a universal one and was wrong for restic, which
 *  exits 1 with "unknown flag: --version" and wants `restic version`. That
 *  reported an installed tool as missing, and the manifest entry now carries the
 *  form it answers to. */
export function commandExists(command, versionArgs = ['--version']) {
  const tokens = [command, ...versionArgs];
  if (!tokens.every((token) => typeof token === 'string' && SAFE_TOKEN.test(token))) return false;
  return spawnSync(tokens.join(' '), { shell: true, stdio: 'ignore' }).status === 0;
}
