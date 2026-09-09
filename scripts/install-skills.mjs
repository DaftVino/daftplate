#!/usr/bin/env node
// Installs this checkout as ONE plugin at ~/.claude/skills/daftplate/ (ADR 0002,
// amended 2026-09-02). Copies over the top; never deletes. That directory holds
// every other skill you use.
// Usage: node scripts/install-skills.mjs [--target <dir>] [--dry-run]
import {
  existsSync, readdirSync, lstatSync, cpSync, readFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli, EXIT_CODES } from './lib/cli.mjs';
import { renderCheckoutBlock, findCheckoutSpan } from './lib/checkout-marker.mjs';
// Temp-file-plus-rename with mode preservation, EPERM retry and exact cleanup.
// It lived here until enrollment needed the same guarantees for .daftplate.json.
import { writeAtomically } from './lib/atomic-write.mjs';

/** The one directory under `~/.claude/skills/` that daftplate owns. Everything
 *  else in there belongs to someone else, which is ADR 0002's whole no-delete
 *  argument — and a single owned subtree is what finally makes the boundary
 *  nameable. */
export const PLUGIN_DIR_NAME = 'daftplate';

/** The manifest that makes the copied tree load as a plugin rather than sit
 *  there inert. Measured 2026-09-02: `<root>/skills/<name>/SKILL.md` loads and a
 *  skill directory at the plugin root does not, so the source layout — this file
 *  beside the existing `skills/` — is the shape the loader already wants. */
export const PLUGIN_MANIFEST_REL = join('.claude-plugin', 'plugin.json');

/** The one install error main may translate to success. Its type, rather than
 *  its message, carries the public-export policy across the library boundary:
 *  the export deliberately has no skills/ tree, while a missing manifest or a
 *  cpSync failure means a checkout that claimed it could install did not.
 *
 *  A pre-check in main would repeat installSkills()'s source validation and let
 *  the two drift; a message check would make rewording diagnostics change the
 *  process protocol. Keeping the structural signal private also leaves the
 *  library contract intact: direct callers still receive a thrown Error for a
 *  source tree from which there is nothing to install. `#274 (FORGE-335)` F4. */
class SkillsDirectoryAbsentError extends Error {}

/** The frontmatter opener, in either line ending. It was `startsWith('---\n')`,
 *  which is exact-LF, and a `SKILL.md` an editor on this platform writes begins
 *  `---\r\n` — so the file stopped being a skill with no error, no skip message
 *  and nothing for an owner to read. `#273 (FORGE-334)`.
 *
 *  A regex rather than a second `startsWith`, because the opener's LENGTH is what
 *  the slice below needs and the two must not be able to disagree: four for LF,
 *  five for CRLF, taken from the match rather than written as a constant beside
 *  it. The closing `indexOf('\n---')` needs no change and is not given one — a
 *  CRLF close is `\r\n---`, whose `\n` that call already finds. */
const FRONTMATTER_OPEN = /^---\r?\n/;

/** The declared `name:` in a SKILL.md's frontmatter, or null when the file is
 *  absent, unreadable, or not a skill at all. Deliberately not a parser: it
 *  answers one question, and every failure is "not a skill", never a throw. */
function declaredSkillName(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const open = FRONTMATTER_OPEN.exec(text);
  if (!open) return null;
  const end = text.indexOf('\n---', open[0].length);
  if (end === -1) return null;
  // `\s*$` under `/m` already tolerates the `\r` a CRLF line leaves before the
  // newline — JS treats `\r` as a LineTerminator and `\s` matches it — so the
  // name match needed no widening. That narrowing is `plan-tooling-ci` D1's, and
  // it is what makes this a one-line class rather than a sweep.
  const match = /^name:\s*(\S+)\s*$/m.exec(text.slice(open[0].length, end));
  return match ? match[1] : null;
}

/**
 * Loose skill directories under `targetRoot` that this install now shadows.
 *
 * Measured 2026-09-02: when a loose skill and a plugin skill share a bare name,
 * **the loose one wins it** and the plugin copy is reachable only as
 * `daftplate:<name>`. So these are not leftovers to tidy at leisure — until they
 * are gone the plugin install has not taken effect, and the report says so.
 *
 * Three things must hold before a path is named, and the third is the one that
 * matters: the directory must hold a SKILL.md whose frontmatter name equals the
 * directory name. Naming a path on the strength of its name alone would put a
 * directory somebody else created into a removal command, which is CLAUDE.md #5's
 * spirit even though this function deletes nothing. Third-party packs install
 * under their own prefix (`skills/external-packs.json` records why), so a bare
 * `orient/` holding a skill called `orient` is daftplate's.
 */
export function shadowedLooseSkills(targetRoot, names) {
  const found = [];
  for (const name of names) {
    // The plugin's own root. A loose skill there is the refusal below, not a
    // sibling to be listed twice.
    if (name === PLUGIN_DIR_NAME) continue;
    const dir = join(targetRoot, name);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch { continue; }
    if (declaredSkillName(join(dir, 'SKILL.md')) !== name) continue;
    found.push(dir);
  }
  return found;
}

/** Where an installed daftplate skill actually is, this era or the last one.
 *  The plugin copy wins because it is the one this installer writes; the loose
 *  path is checked second because it survives until the owner removes it, and a
 *  consumer that only knew one shape would be wrong on every machine mid-migration. */
export function installedSkillDir(skillsRoot, name) {
  const plugin = join(skillsRoot, PLUGIN_DIR_NAME, 'skills', name);
  if (existsSync(join(plugin, 'SKILL.md'))) return plugin;
  const loose = join(skillsRoot, name);
  return existsSync(join(loose, 'SKILL.md')) ? loose : null;
}

/**
 * Copy this checkout's skills into `targetRoot` as one plugin tree.
 *
 * One directory now, not 22 siblings: `<targetRoot>/daftplate/` holding
 * `.claude-plugin/plugin.json` and `skills/<name>/`. A name collision with
 * somebody else's skill used to overwrite it silently; under one owned subtree
 * there is nothing of theirs to collide with.
 *
 * It **refuses** rather than writing when a loose `daftplate` skill occupies the
 * plugin's own root, because that SKILL.md is a file daftplate did not create in
 * this shape and must not remove. The condition is self-clearing: once the owner
 * removes it the directory holds only what this function writes.
 */
export function installSkills(sourceRoot, targetRoot, opts = {}) {
  const skillsDir = join(sourceRoot, 'skills');
  if (!existsSync(skillsDir)) throw new SkillsDirectoryAbsentError(`${sourceRoot} has no skills/ directory`);
  const manifest = join(sourceRoot, PLUGIN_MANIFEST_REL);
  // Without it the tree copies fine and loads as nothing at all — the failure
  // this refusal exists to make loud rather than silent.
  if (!existsSync(manifest)) throw new Error(`${sourceRoot} has no ${PLUGIN_MANIFEST_REL}, so nothing would load as a plugin`);

  const root = join(targetRoot, PLUGIN_DIR_NAME);
  const names = [];
  const skipped = [];

  for (const name of readdirSync(skillsDir)) {
    const source = join(skillsDir, name);
    if (!lstatSync(source).isDirectory()) continue;
    if (!existsSync(join(source, 'SKILL.md'))) { skipped.push(name); continue; }
    names.push(name);
  }
  names.sort();
  skipped.sort();

  const stray = join(root, 'SKILL.md');
  if (existsSync(stray)) {
    // Nothing is written, so `installed` is empty rather than aspirational. The
    // shadow list still renders: one paste should clear every blocker at once,
    // rather than sending the owner round the loop twice.
    return {
      installed: [], skipped, root, refused: stray, shadowed: shadowedLooseSkills(targetRoot, names),
    };
  }

  if (!opts.dryRun) {
    cpSync(join(sourceRoot, '.claude-plugin'), join(root, '.claude-plugin'), { recursive: true, force: true });
    // Per skill rather than the whole directory: a skill under construction has
    // no SKILL.md and must not install half of itself, and `external-packs.json`
    // is a declaration this repo reads from the checkout, never from the install.
    for (const name of names) {
      cpSync(join(skillsDir, name), join(root, 'skills', name), { recursive: true, force: true });
    }
  }

  return {
    installed: names, skipped, root, refused: null, shadowed: shadowedLooseSkills(targetRoot, names),
  };
}

/** One paste-ready line, in the shape `reconcile-manifest.mjs` established: the
 *  tool finds and names, the human acts. Never run from here. */
export function removalCommand(paths) {
  return `rm -rf ${paths.map((p) => `"${p.replace(/\\/g, '/')}"`).join(' ')}`;
}

export const GATE_SOURCE_REL = join('skills', 'crit', 'scripts', 'report-gate.mjs');
export const GATE_INSTALLED_NAME = 'crit-report-gate.mjs';

export const ATTRIBUTION_GATE_SOURCE_REL = join('scripts', 'attribution-gate.mjs');
export const ATTRIBUTION_GATE_INSTALLED_NAME = 'attribution-gate.mjs';

/**
 * Copy one gate script user-level and register it on one hook event.
 *
 * Both gates are installed here rather than shipped in
 * `base/files/dot-claude/settings.json`, for ADR 0002's reason applied to hooks:
 * that file lands in a *scaffolded* repo's `.claude/`, and neither design reviews
 * nor pull requests are confined to scaffolded repos.
 *
 * It only ever adds. An existing group on the same event keeps its place, its
 * order and its contents; a new daftplate-owned group is appended rather than
 * merged into a matching one, because merging would edit a group the user wrote.
 * A settings.json that will not parse is left exactly as it is, and nothing is
 * copied in that case either — a gate on disk that no event references is debris.
 */
function registerGate({ sourceRoot, claudeDir, sourceRel, installedName, event, matcher }, opts = {}) {
  const source = join(sourceRoot, sourceRel);
  if (!existsSync(source)) return { skipped: `${sourceRel} is not in this checkout`, registered: false };

  const dest = join(claudeDir, installedName);
  const settingsPath = join(claudeDir, 'settings.json');

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      return { skipped: `${settingsPath} could not be parsed; nothing was changed`, registered: false };
    }
  }

  const command = `node "${dest.replace(/\\/g, '/')}"`;
  const groups = Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [];
  const already = groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .some((hook) => typeof hook?.command === 'string' && hook.command.includes(installedName));

  if (!opts.dryRun) {
    // Refreshed on every real run even when already registered: the script is
    // daftplate-owned, so an installed copy older than the checkout is stale, not
    // someone's edit.
    cpSync(source, dest, { force: true });
    if (!already) {
      const group = matcher ? { matcher, hooks: [{ type: 'command', command }] }
        : { hooks: [{ type: 'command', command }] };
      const next = {
        ...settings,
        hooks: { ...settings.hooks, [event]: [...groups, group] },
      };
      // Atomic, not writeFileSync. settings.json holds every hook the user has
      // configured, so a crash or a full disk mid-write disables all of them —
      // and because the file is JSON, a torn write is also unparseable, at which
      // point the parse-or-bail above refuses to touch it ever again. There is no
      // plain-write fallback: that reintroduces the torn write exactly when
      // contention makes it likeliest.
      // opts is forwarded so a test can inject `rename`, the same seam
      // recordCheckout() and the atomic writer's own suite already use.
      const refused = writeAtomically(settingsPath, `${JSON.stringify(next, null, 2)}\n`, opts);
      // The copied gate is left in place. Deleting it would be cleanup of a file
      // whose absence is not the failure, and this installer never deletes.
      if (refused) return { skipped: refused, registered: false, path: dest, command };
    }
  }

  return { skipped: null, registered: !already, path: dest, command };
}

/** The /crit report gate, on Stop. Phase 2c binds: the hook and the skill it
 *  enforces ship together, so no gate in the source means no registration. */
export function registerReportGate(sourceRoot, claudeDir, opts = {}) {
  return registerGate({
    sourceRoot,
    claudeDir,
    sourceRel: GATE_SOURCE_REL,
    installedName: GATE_INSTALLED_NAME,
    event: 'Stop',
  }, opts);
}

/** The attribution gate, on PreToolUse, matched to Bash. The matcher is what keeps
 *  it off every other tool call; the gate re-checks `tool_name` anyway, because a
 *  matcher is configuration a user can edit and the decision must hold without it. */
export function registerAttributionGate(sourceRoot, claudeDir, opts = {}) {
  return registerGate({
    sourceRoot,
    claudeDir,
    sourceRel: ATTRIBUTION_GATE_SOURCE_REL,
    installedName: ATTRIBUTION_GATE_INSTALLED_NAME,
    event: 'PreToolUse',
    matcher: 'Bash',
  }, opts);
}

export const GLOBAL_TEMPLATE_REL = join('engineering-standards', 'claude-md-global.md');

/** The line that decides `gatesPresent`. One constant, pinned against the shipped
 *  template by a test, because if the two drift every install on earth reports the
 *  gates missing. */
export const GATES_SENTINEL = '## Non-negotiable gates';

/** Splice the block into `text`, or append it when there is no span yet.
 *  Returns null when a marker is present but its span is unusable — that is a
 *  refusal, never a repair.
 *
 *  `replaced` rather than `previous !== null` is what tells the caller which happened:
 *  a span whose delimiters are sound but whose path line has been edited away is a
 *  replacement with no previous path, and calling that 'added' would report an append
 *  where a rewrite occurred. */
function placeBlock(text, block) {
  const span = findCheckoutSpan(text);
  if (span.ok) {
    return { text: text.slice(0, span.start) + block + text.slice(span.end), previous: span.path, replaced: true };
  }
  if (span.present) return null;

  const separator = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${text}${separator}${block}\n`, previous: null, replaced: false };
}

/**
 * Record the daftplate checkout path in <claudeDir>/CLAUDE.md, so the standards
 * pointer every scaffolded repo carries resolves to something (#98, ADR 0001).
 *
 *                     ~/.claude/CLAUDE.md
 *                             │
 *               ┌─────────────┴─────────────┐
 *          does not exist                 exists
 *               │                           │
 *     ┌─────────┴─────────┐        count marker pairs
 *     │                   │                 │
 *  template            template     ┌───────┼────────────────┐
 *  missing              present     0       1            2+, or
 *     │                   │         │    well-formed    unclosed/
 *  REFUSED             CREATED   ADDED       │          reordered
 *  (D2 cost)          seed from  append      │              │
 *                     the global  block   compare       REFUSED
 *                     template      │      path        (D7, CLAUDE.md #5)
 *                        │          │         │
 *                        └──────────┴────┬────┴──────┐
 *                                     equal      different
 *                                        │            │
 *                                     CURRENT      UPDATED
 *                                    no write    rewrite in
 *                                    (D1)        place (D3)
 *                                        │            │
 *                                        └─────┬──────┘
 *                                        atomic write (D7)
 *                                              │
 *                                    ┌─────────┴─────────┐
 *                               rename OK          EPERM ×3
 *                                    │                   │
 *                                  done              REFUSED
 *                                                  (file untouched)
 *
 * This diagram is the truth table for all seven cells and each has a test; keeping it
 * accurate is part of any later change to these branches, because the next reader will
 * trust it.
 *
 * `gatesPresent` is reported, never repaired. Splicing template prose into a
 * user-authored file writes content daftplate did not create into someone else's
 * document — CLAUDE.md #5's spirit even though nothing is deleted. The human merges it.
 */
export function recordCheckout(sourceRoot, claudeDir, opts = {}) {
  const target = join(claudeDir, 'CLAUDE.md');
  const block = renderCheckoutBlock(sourceRoot);
  const refuse = (reason) => ({ path: target, action: 'refused', previous: null, gatesPresent: null, reason });

  let base;
  let action;
  let baseName = target;      // whose marker a refusal should name
  if (existsSync(target)) {
    base = readFileSync(target, 'utf8');
    action = 'added';
  } else {
    // D2: seed from the shipped template, gates and all. A thin file carrying only the
    // marker satisfies every check here while making the one thing ADR 0001:25
    // guarantees — the non-negotiable gates — absent.
    const template = join(sourceRoot, GLOBAL_TEMPLATE_REL);
    if (!existsSync(template)) {
      return refuse(`${GLOBAL_TEMPLATE_REL} is not in ${sourceRoot}, and creating the file without it would leave the machine with no gates`);
    }
    base = readFileSync(template, 'utf8');
    baseName = template;
    action = 'created';
  }

  const placed = placeBlock(base, block);
  if (!placed) return refuse(`${baseName} has a marker daftplate cannot bound: ${findCheckoutSpan(base).reason}`);

  const gatesPresent = placed.text.includes(GATES_SENTINEL);
  const result = { path: target, action, previous: placed.previous, gatesPresent, reason: null };

  if (action === 'added' && placed.replaced) {
    // The block was already there: unchanged means no write at all (D1), anything else
    // means the record names the checkout you just installed from (D3).
    result.action = placed.text === base ? 'current' : 'updated';
    if (result.action === 'current') return result;
  }

  if (opts.dryRun) return result;

  const refusal = writeAtomically(target, placed.text, opts);
  return refusal ? refuse(refusal) : result;
}

function main(argv, opts = {}) {
  const args = argv.slice(2);
  const log = opts.log ?? console.log;
  const logError = opts.logError ?? console.error;
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  // The invariant, after #103: every installer INPUT comes from the checkout that
  // physically contains this script, and `--target` controls destinations only.
  // The three call sites below used to disagree — recordCheckout() resolved from the
  // script while installSkills() and registerReportGate() read process.cwd() — so
  // running the script by path from another repo installed that repo's skills.
  const sourceRoot = opts.sourceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const targetFlag = args.indexOf('--target');
  const given = targetFlag === -1 ? null : args[targetFlag + 1];
  // A --target with nothing after it used to reach dirname() as undefined and take the
  // process down on an uncaught TypeError. Refusing beats resolveProfile's ignore-it
  // treatment of a valueless --profile: a profile is additive information, a target is
  // where files get copied, and defaulting would write to a directory nobody named.
  if (targetFlag !== -1 && (!given || given.startsWith('--'))) {
    logError('--target needs a directory: node scripts/install-skills.mjs --target <dir>');
    return 1;
  }
  const target = given ?? join(claudeDir, 'skills');
  const dryRun = args.includes('--dry-run');

  // D5: the public export ships scripts/ and withholds skills/ (ADR 0002), and its user
  // is exactly the person who needs the checkout recorded. installSkills() keeps
  // throwing — a caller asking it to install from a tree with no skills is making an
  // error — but the CLI reports it and carries on to the work it can still do.
  // Whether the skills were installed, carried to the end rather than returned
  // here. The gate registrations and the checkout record do not depend on the
  // install and are worth doing anyway — the existing behaviour, and the reason
  // this is a flag rather than an early return: a partial success is the honest
  // outcome, an idempotent rerun converges, and abandoning work that would have
  // succeeded to report a failure sooner helps nobody. What was wrong was the
  // exit code at the end, not the order of the work. `#274 (FORGE-335)`.
  let refused = false;
  let failed = false;
  try {
    const result = installSkills(sourceRoot, target, { dryRun });
    if (result.refused) {
      refused = true;
      // A refusal, not a delete. The loose `daftplate` skill sits at the exact
      // path the plugin tree occupies, and removing it is the owner's act.
      logError(`skills NOT installed: ${result.refused} is a loose skill sitting at the plugin's own root`);
      logError(`daftplate installs one tree at ${result.root} and never deletes from ${target}.`);
      logError(`remove the following, then run this again:\n  ${removalCommand([result.refused, ...result.shadowed])}`);
    } else {
      log(`${dryRun ? 'would install' : 'installed'} ${result.installed.length} skill(s) as the daftplate plugin at ${result.root}: ${result.installed.join(', ') || 'none'}`);
      for (const name of result.skipped) logError(`skipped (no SKILL.md): ${name}`);
      if (result.shadowed.length) {
        // Worded as a prerequisite because it is one. Measured 2026-09-02: on a
        // shared bare name the LOOSE skill wins, so until these are gone /orient
        // and the rest still fire the old copy and this install has not taken
        // effect. "You may wish to tidy up" would be describing a different fact.
        logError(`migration required: ${result.shadowed.length} loose skill director(ies) still shadow the plugin copy`);
        logError('a loose skill wins the bare name, so /<name> still fires the OLD copy until these are gone');
        logError(`daftplate never deletes from ${target}; remove them yourself:\n  ${removalCommand(result.shadowed)}`);
      }
    }
  } catch (err) {
    logError(`skills not installed: ${err.message}`);
    // D5's case — the public export ships scripts/ and withholds skills/ (ADR
    // 0002) — is the one caught error that is not a failed install. Nothing is
    // in the way and there is nothing for an operator or automation to repair.
    // The type is the policy boundary: prose belongs to the human report above
    // and may change without turning an EACCES, ENOSPC or broken manifest into
    // success. Every other throw records failure but still falls through to the
    // independent gate and checkout work below. `#274 (FORGE-335)` F4.
    if (!(err instanceof SkillsDirectoryAbsentError)) failed = true;
  }

  // dirname(target) rather than claudeDir: where the hook installs is existing
  // behaviour and moving it is not this change's business. The SOURCE is the
  // checkout, per the invariant above.
  const gate = registerReportGate(sourceRoot, dirname(target), { dryRun });
  if (gate.skipped) logError(`report gate not registered: ${gate.skipped}`);
  else if (gate.registered) log(`${dryRun ? 'would register' : 'registered'} the /crit report gate on Stop: ${gate.path}`);
  else log(`/crit report gate already registered: ${gate.path}`);

  // Reported independently of the report gate, and neither rolls the other back.
  // A partial success is the honest outcome — an idempotent rerun converges, and
  // undoing a registration that worked would delete something nobody asked to lose.
  const attribution = registerAttributionGate(sourceRoot, dirname(target), { dryRun });
  if (attribution.skipped) logError(`attribution gate not registered: ${attribution.skipped}`);
  else if (attribution.registered) log(`${dryRun ? 'would register' : 'registered'} the attribution gate on PreToolUse(Bash): ${attribution.path}`);
  else log(`attribution gate already registered: ${attribution.path}`);

  const checkout = recordCheckout(sourceRoot, claudeDir, { dryRun });
  if (checkout.action === 'refused') {
    // Exit 0 anyway (1.2b): the skills genuinely installed, and reporting failure for
    // work that succeeded is a false report. check-machine.mjs reports the missing
    // record, so the fact still reaches the user.
    logError(`checkout NOT recorded: ${checkout.reason} (${checkout.path})`);
  } else {
    log(`${dryRun ? 'would record' : 'recorded'} the daftplate checkout in ${checkout.path}: ${checkout.action} (${sourceRoot})`);
    if (!checkout.gatesPresent) {
      logError(`gates missing from ${checkout.path} — merge ${GLOBAL_TEMPLATE_REL} by hand; nothing here will inject them`);
    }
  }
  // Failure precedes refusal when a broken source tree and a user-owned obstacle
  // coexist. REFUSED says the requested work was deliberately not attempted and
  // moving the named obstacle is sufficient; that is false when validation or
  // copying failed, and especially dangerous after a partial copy. The gates
  // and checkout record are reported on their own lines, so their success does
  // not erase the install outcome automation must act on.
  return failed ? EXIT_CODES.INSTALL_FAILED : refused ? EXIT_CODES.REFUSED : 0;
}

export { main };
runCli(import.meta.url, main);
