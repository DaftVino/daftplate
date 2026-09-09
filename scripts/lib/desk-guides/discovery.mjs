// What EXISTS. Discovery answers that and nothing else -- it never decides what
// prints, never shortens a description, and never reads editorial policy. The
// companion rule lives in config.mjs: policy may not carry a discovered fact.
//
// Two refusals here are load-bearing rather than defensive. A cache directory is
// not an installation contract, so `codex plugin list` is the only source for
// Codex state and an unparseable line is fatal instead of skipped -- a skipped
// row prints a shorter card that looks complete. And a duplicate canonical key
// is fatal naming both paths, because the alternative is a later write silently
// winning and one real skill vanishing from a page that claims to account for
// everything.
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseKey } from './config.mjs';

export class DiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

const fail = (message) => { throw new DiscoveryError(message); };

/** The two Codex skill roots the design names without giving them canonical
 *  identifiers. `codex:<plugin>:<skill>` has no plugin for a root that is not a
 *  plugin, so these two slots are reserved here and recorded rather than quietly
 *  chosen. Neither is eligible for page A2: the design admits only rows reported
 *  `installed, enabled` by `codex plugin list`, and a personal or repo-scoped
 *  skill is not a plugin row at all. They are discovered so nothing disappears. */
export const CODEX_PERSONAL_SLOT = 'personal';
export const CODEX_REPO_SLOT = 'repo';

/** Frontmatter, deliberately not YAML. Only the two fields a card can print are
 *  read; anything else in the block is another tool's business. A repeated key is
 *  refused rather than last-write-wins, because two `name:` lines mean the file
 *  disagrees with itself about its own identity. */
export function readFrontmatter(text) {
  const match = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (!m) continue;                       // list items, nested blocks, blank lines
    const [, key, rawValue] = m;
    if (key !== 'name' && key !== 'description') continue;
    if (fields.has(key)) fail(`frontmatter declares '${key}' twice`);
    fields.set(key, unquote(rawValue.trim()));
  }
  const name = fields.get('name');
  if (!name) return null;                   // not a skill: a helper directory, or a fragment
  return { name, description: fields.get('description') ?? '' };
}

function unquote(value) {
  const m = value.match(/^(['"])([\s\S]*)\1$/);
  return m ? m[2] : value;
}

/** Directory children, sorted, directories only, symlinks never followed.
 *  Sorted at the boundary so every downstream map iterates in one order and the
 *  inventory is byte-identical across runs and platforms. */
function subdirs(root) {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .filter((name) => {
      const full = join(root, name);
      try {
        const stats = lstatSync(full);
        return stats.isDirectory() && !stats.isSymbolicLink();
      } catch {
        return false;
      }
    });
}

function readSkillDir(dir, name) {
  const file = join(dir, name, 'SKILL.md');
  if (!existsSync(file)) return null;
  let front;
  try {
    front = readFrontmatter(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${file}: ${err.message}`);
  }
  if (!front) return null;
  return { file, front };
}

/** One registry per run. Identity is the canonical key; a second registration of
 *  the same key from a different path is fatal and names both. */
function makeRegistry() {
  const byKey = new Map();
  return {
    byKey,
    add(key, record) {
      if (!parseKey(key)) fail(`'${key}' is not a well-formed canonical key (from ${record.sourcePath})`);
      const existing = byKey.get(key);
      if (existing) {
        fail(`duplicate canonical key '${key}' from two source paths: ${existing.sourcePath} and ${record.sourcePath}`);
      }
      byKey.set(key, { key, ...record });
    },
    /** Reconciliation, not collision: an installed copy of a repo-owned skill is
     *  the same skill seen twice. Recording drift is the point -- the installed
     *  tree is what an agent actually loads, and a stale copy is exactly the
     *  silent divergence these pages exist to surface. */
    reconcile(key, record) {
      const existing = byKey.get(key);
      if (!existing) return this.add(key, record);
      existing.installedPath = record.sourcePath;
      existing.drift = existing.description !== record.description;
      return undefined;
    },
  };
}

/** Every directory under `profiles/`, with the metadata block parsed by the one
 *  parser that owns it. A second parser here would create a second definition of
 *  valid profile metadata, and the two would drift. */
export function discoverProfiles({ profilesRoot, parseProfileMeta }) {
  if (typeof parseProfileMeta !== 'function') fail('discoverProfiles needs parseProfileMeta injected');
  return subdirs(profilesRoot).map((name) => {
    const file = join(profilesRoot, name, 'profile.md');
    if (!existsSync(file)) fail(`profiles/${name} has no profile.md`);
    const meta = parseProfileMeta(readFileSync(file, 'utf8'));
    if (!meta) fail(`profiles/${name}/profile.md has no parseable \`\`\`profile metadata block`);
    return {
      name,
      sourcePath: `profiles/${name}/profile.md`,
      verify: meta.verify,
      test: meta.test,
      deploy: meta.deploy,
      docsSubdirs: meta.docsSubdirs,
      skills: subdirs(join(profilesRoot, name, 'files', 'dot-claude', 'skills')),
    };
  });
}

/** `codex plugin list` output, parsed strictly.
 *
 *  Strict means every non-blank line must classify. The tempting alternative --
 *  match plugin rows and ignore the rest -- reports a shorter card that looks
 *  complete, which is the failure mode the page exists to prevent. */
export function parseCodexPluginList(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') {
    fail('`codex plugin list` produced no output; page A2 cannot be generated from a cache scan');
  }
  const rows = [];
  const lines = stdout.split(/\r?\n/);
  let expectMarketplacePath = false;
  let sawHeader = false;

  for (const [i, raw] of lines.entries()) {
    const line = raw.trimEnd();
    if (line.trim() === '') { continue; }

    if (/^Marketplace\s+`[^`]+`$/.test(line.trim())) { expectMarketplacePath = true; continue; }
    if (expectMarketplacePath) { expectMarketplacePath = false; continue; }

    const fields = line.trim().split(/\s{2,}/);
    if (fields[0] === 'PLUGIN' && fields[1] === 'STATUS') { sawHeader = true; continue; }
    if (/^[-\s|+]+$/.test(line)) continue;                       // a rule under the header

    const [plugin, status, ...rest] = fields;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plugin ?? '')) {
      fail(`\`codex plugin list\` line ${i + 1} is not a plugin row and not a recognised header: ${line.trim()}`);
    }
    const state = parseCodexStatus(status, i + 1, line.trim());
    // `not installed` rows carry no version, so the columns collapse from four to
    // three. Take the path from the end rather than by index.
    const path = rest.length ? rest[rest.length - 1] : '';
    rows.push({ plugin, status, path, installed: state.installed, enabled: state.enabled });
  }

  if (!sawHeader) fail('`codex plugin list` output has no PLUGIN/STATUS header; the supported format was not recognised');
  return rows;
}

/** The status column, as a closed set of tokens rather than a whole-string match.
 *
 *  Read as two independent facts, because collapsing them is the bug: checking
 *  only for the word `installed` passes an installed-but-disabled plugin, and
 *  checking only for `enabled` passes a marketplace row that is enabled in
 *  config but was never installed. Both print an inactive plugin as active on a
 *  card whose whole claim is that it lists what is live. An unknown token is
 *  fatal -- a status this parser does not understand is not a status it may
 *  quietly read as "off". */
const STATUS_TOKENS = new Set(['installed', 'not installed', 'enabled', 'disabled', 'not enabled']);

function parseCodexStatus(status, lineNumber, line) {
  const text = (status ?? '').trim();
  const tokens = text.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0 || tokens.some((token) => !STATUS_TOKENS.has(token))) {
    fail(`\`codex plugin list\` line ${lineNumber} has the unrecognised status '${text}': ${line}`);
  }
  return {
    installed: tokens.includes('installed'),
    enabled: tokens.includes('enabled'),
  };
}

/** Where `codex` actually is, and how it has to be started.
 *
 *  On Windows the Codex CLI is an npm shim -- `codex.cmd` next to `codex.ps1`,
 *  no `.exe` -- and Node refuses to spawn a `.cmd` without a shell. The repo rule
 *  is that no child process gets a shell, so the shim is resolved here and handed
 *  to `cmd.exe` as separate argv elements instead. That keeps the rule's actual
 *  content: no command STRING is ever built, so there is no re-parsing of a
 *  joined line and nothing to inject into. `shell: true` would have built exactly
 *  that string. */
export function resolveExecutable(command, env = process.env) {
  const isWindows = process.platform === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(isWindows ? ';' : ':').filter(Boolean);
  // Extensions before the bare name on Windows, and this order is the whole
  // point: npm ships `codex`, `codex.cmd` and `codex.ps1` side by side, and the
  // extensionless one is a POSIX shell script that Windows cannot execute.
  // Trying it first resolves the tool to a file that will not run.
  const exts = isWindows
    ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '']
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (lstatSync(candidate).isFile()) return candidate;
      } catch { /* not here; keep looking */ }
    }
  }
  return null;
}

const SHIM = /\.(cmd|bat)$/i;

/** Run `codex plugin list` with no shell, and refuse anything that is not a
 *  clean exit. A missing or broken `codex` fails page A2 with install guidance
 *  rather than emitting an empty card that reads as "nothing is installed". */
export function runCodexPluginList(run = defaultRun) {
  const result = run('codex', ['plugin', 'list']);
  if (result.error && (result.error.code === 'ENOENT' || result.error.code === 'ENOTFOUND')) {
    fail('`codex` is not on PATH, so page A2 cannot report installed plugins. Install the Codex CLI, then run `codex plugin install <name>` and `codex plugin list` to confirm state.');
  }
  if (result.error) fail(`\`codex plugin list\` could not be run: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`\`codex plugin list\` exited ${result.status}: ${(result.stderr ?? '').trim() || 'no stderr'}`);
  }
  return result.stdout ?? '';
}

const defaultRun = (command, args) => {
  const options = { shell: false, encoding: 'utf8', windowsHide: true };
  const resolved = resolveExecutable(command);
  if (!resolved) return { error: Object.assign(new Error(`${command} not found on PATH`), { code: 'ENOENT' }) };
  return SHIM.test(resolved)
    ? spawnSync(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', resolved, ...args], options)
    : spawnSync(resolved, args, options);
};

/**
 * Everything discoverable, as one registry of canonical keys.
 *
 * Roots are parameters rather than constants so a fixture tree is the ordinary
 * case and the maintainer's own machine is never what a test depends on. A root
 * that does not exist yields nothing and is recorded as absent -- a public
 * export clone has no `skills/`, and that is a missing source, not a crash.
 */
export function discover({
  repoRoot,
  profilesRoot = repoRoot ? join(repoRoot, 'profiles') : null,
  skillsRoot = repoRoot ? join(repoRoot, 'skills') : null,
  installedClaudeRoot = null,
  codexPersonalRoot = null,
  codexRepoRoot = null,
  parseProfileMeta,
  run = defaultRun,
  includeCodex = true,
} = {}) {
  const registry = makeRegistry();
  const sources = [];
  const note = (id, path, found) => sources.push({ id, path: path ?? null, present: Boolean(path) && existsSync(path), found });

  // --- repo-owned Claude skills -------------------------------------------
  let repoSkills = 0;
  for (const name of subdirs(skillsRoot)) {
    const read = readSkillDir(skillsRoot, name);
    if (!read) continue;
    registry.add(`claude:${name}`, {
      tool: 'claude',
      origin: 'repo',
      skill: name,
      sourcePath: read.file,
      description: read.front.description,
      declaredName: read.front.name,
    });
    repoSkills += 1;
  }
  note('claude-repo', skillsRoot, repoSkills);

  // --- installed Claude skills --------------------------------------------
  let installedSkills = 0;
  for (const name of subdirs(installedClaudeRoot)) {
    const read = readSkillDir(installedClaudeRoot, name);
    if (!read) continue;                    // helper directory with no frontmatter
    registry.reconcile(`claude:${name}`, {
      tool: 'claude',
      origin: 'installed',
      skill: name,
      sourcePath: read.file,
      installedPath: read.file,
      description: read.front.description,
      declaredName: read.front.name,
    });
    installedSkills += 1;
  }
  note('claude-installed', installedClaudeRoot, installedSkills);

  // --- profile-scoped Claude skills ---------------------------------------
  const profiles = discoverProfiles({ profilesRoot, parseProfileMeta });
  let profileSkills = 0;
  for (const profile of profiles) {
    const root = join(profilesRoot, profile.name, 'files', 'dot-claude', 'skills');
    for (const name of profile.skills) {
      const read = readSkillDir(root, name);
      if (!read) continue;
      registry.add(`profile:${profile.name}:${name}`, {
        tool: 'profile',
        origin: 'profile',
        profile: profile.name,
        skill: name,
        sourcePath: read.file,
        description: read.front.description,
        declaredName: read.front.name,
      });
      profileSkills += 1;
    }
  }
  note('claude-profile', profilesRoot, profileSkills);

  // --- Codex -----------------------------------------------------------------
  let codexSkills = 0;
  if (includeCodex) {
    const rows = parseCodexPluginList(runCodexPluginList(run));
    for (const row of rows) {
      // Both halves, every time. A marketplace entry that is merely available
      // must never print as installed, and an installed-but-disabled plugin is
      // not active either.
      if (!(row.installed && row.enabled)) continue;
      const root = join(row.path, 'skills');
      for (const name of subdirs(root)) {
        const read = readSkillDir(root, name);
        if (!read) continue;
        registry.add(`codex:${row.plugin}:${name}`, {
          tool: 'codex',
          origin: 'plugin',
          plugin: row.plugin,
          skill: name,
          sourcePath: read.file,
          description: read.front.description,
          declaredName: read.front.name,
        });
        codexSkills += 1;
      }
    }
    note('codex-plugins', null, codexSkills);

    for (const [slot, root, id] of [
      [CODEX_PERSONAL_SLOT, codexPersonalRoot, 'codex-personal'],
      [CODEX_REPO_SLOT, codexRepoRoot, 'codex-repo'],
    ]) {
      let found = 0;
      for (const name of subdirs(root)) {
        const read = readSkillDir(root, name);
        if (!read) continue;
        registry.add(`codex:${slot}:${name}`, {
          tool: 'codex',
          origin: slot,
          plugin: slot,
          skill: name,
          sourcePath: read.file,
          description: read.front.description,
          declaredName: read.front.name,
          // Ineligible for A2 by the design's own rule: it is not a plugin row.
          eligibleForCard: false,
        });
        found += 1;
      }
      note(id, root, found);
    }
  }

  return {
    entries: [...registry.byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    profiles,
    sources: sources.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}
