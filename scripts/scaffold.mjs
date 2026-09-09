#!/usr/bin/env node
// Composes base + profile into a destination repo and substitutes the templates.
// Usage: node scripts/scaffold.mjs <templates-root> <type> <dest> --name=<n> --summary=<s>
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './lib/cli.mjs';
import { applyLayer } from './apply-layer.mjs';
import { parseProfileMeta } from './verify-templates.mjs';
import { verifyRepo } from './verify-repo.mjs';
import { walkFiles } from './lib/fs.mjs';
import { buildProvenance, writeProvenance } from './lib/provenance.mjs';

const MARKER_SOURCES = {
  '<!-- profile:constraints -->': 'claude-md-fragment.md',
  '<!-- profile:routing -->': 'skill-routing.md',
  '<!-- profile:context -->': 'context-rules.md',
};

// The tokens scaffold() cannot derive and a caller must therefore supply. YEAR is
// filled from values.year; PROJECT_NAME and PROJECT_SUMMARY from values.tokens.
// The other three <TOKEN>s -- VERIFY_COMMAND, TEST_COMMAND, DEPLOY_COMMAND -- come
// from the profile.md metadata block, so no operator ever names them.
//
// Exported so enrollment consumes the contract rather than restating it: a fourth
// required token added here must not be something enroll-repo.mjs can silently miss.
export const SCAFFOLD_INPUT_TOKENS = ['YEAR', 'PROJECT_NAME', 'PROJECT_SUMMARY'];

// The substitution refusal carries a code so a caller can translate it without
// matching on a message. Only sync knows which manifest omitted the token and what
// an operator does about it; only this file knows which token and which file.
export const MISSING_TOKEN = 'DAFTPLATE_MISSING_TOKEN';

const TEXT_ONLY = /\.(md|txt|json|ya?ml|m?js|cjs|ts|html|css|example)$/i;

const isTextRel = (rel) => {
  const name = rel.split('/').pop();
  return name.startsWith('.') || !name.includes('.') || TEXT_ONLY.test(name);
};

function textFiles(dir) {
  return walkFiles(dir)
    .filter(({ isDir, rel }) => !isDir && isTextRel(rel))
    .map(({ rel }) => rel);
}

// Scaffolding into a directory that already holds work is destructive in a way no
// later check can undo: the layers write over whatever they collide with, and
// substitution used to rewrite every <UPPER_SNAKE> token in the whole tree. The rule
// lived only in skills/new-project/SKILL.md §2 — prose an agent may skip, a direct
// `import { scaffold }` never reads, and the CLI never consulted at all. It belongs
// in the engine, before any write, because the engine is the thing that writes.
//
// Kept private rather than exported. An exported Set is caller-mutable, which would
// turn a safety rule into state any importer can widen; the policy is tested through
// assertEmptyDest's behaviour instead. This deliberately departs from AC 7 of
// docs/designs/2026-07-28-spec-scaffold-dest-guard.md, which predates that objection.
const DEST_ALLOWED_ENTRIES = new Set(['.git']);

/**
 * Refuse a destination daftplate did not create. Read-only: it never creates the
 * path it is asked about, so a refused precondition leaves nothing behind.
 *
 * Empty means empty, or holding nothing but `.git` — scaffolding into a freshly
 * `git init`ed directory is the flow /new-project actually uses. Any other dotfile
 * is refused; a `.env` at the destination is someone's work.
 *
 * `lstatSync`, not `statSync`: a symlink at the destination is not followed and
 * treated as an owned directory.
 */
export function assertEmptyDest(destDir) {
  if (!existsSync(destDir)) return;
  if (!lstatSync(destDir).isDirectory()) {
    throw new Error(`refusing to scaffold: ${destDir} exists and is not a directory`);
  }
  const found = readdirSync(destDir).filter((n) => !DEST_ALLOWED_ENTRIES.has(n)).sort();
  if (!found.length) return;
  throw new Error(
    `refusing to scaffold: ${destDir} is not empty — found ${found.join(', ')} — ` +
    'scaffold into a new or empty directory (only .git may be present); ' +
    'to bring an existing repo under daftplate use /enroll, and to update one ' +
    'already carrying .daftplate.json use /sync-standards',
  );
}

export function injectFragments(destDir, profileDir) {
  const claudeMd = join(destDir, 'CLAUDE.md');
  let text = readFileSync(claudeMd, 'utf8');
  const replaced = [];

  for (const [marker, file] of Object.entries(MARKER_SOURCES)) {
    if (!text.includes(marker)) continue;
    const source = join(profileDir, file);
    if (!existsSync(source)) throw new Error(`profile is missing ${file}, required by ${marker}`);
    text = text.replace(marker, readFileSync(source, 'utf8').trim());
    replaced.push(marker);
  }

  writeFileSync(claudeMd, text, 'utf8');
  return replaced;
}

/**
 * Substitute <TOKEN>s. `paths` scopes the walk to files the caller knows it wrote;
 * omitted, it falls back to the whole tree for direct callers that own the whole tree.
 *
 * scaffold() always supplies it. Walking the destination instead would rewrite tokens
 * in a `.git` hook, a pre-existing fixture, or anything else the layers did not put
 * there — which is the defect, not a convenience.
 */
export function fillPlaceholders(destDir, values, paths) {
  let count = 0;
  const targets = paths === undefined
    ? textFiles(destDir)
    : [...paths].filter((rel) => isTextRel(rel) && existsSync(join(destDir, rel)));
  for (const rel of targets) {
    const path = join(destDir, rel);
    const before = readFileSync(path, 'utf8');
    const after = before.replace(/<([A-Z][A-Z_]{2,})>/g, (match, key) => {
      // Two cases the old single condition collapsed into one. A key ABSENT from
      // the map is not daftplate's to substitute -- `<HTTP>` in someone's README
      // survives untouched, and must keep doing so. A key PRESENT holding
      // `undefined` -- or `null`, which is how a JSON manifest spells the same
      // thing -- is a declared-missing input, and substituting it is how
      // `Copyright (c) undefined` reached repositories: a caller that spreads a
      // token map it does not have manufactures own properties holding
      // `undefined`, which satisfied `key in values` exactly as a real value does.
      //
      // Refusing rather than leaving the token in place is deliberate. A silent
      // skip removes the string "undefined" from the output and keeps the bug --
      // the candidate still differs from the recorded digest, still classifies
      // UPDATE, and still gets written over the correct file. Corruption respelled.
      if (!(key in values)) return match;
      if (values[key] === undefined || values[key] === null) {
        const error = new Error(
          `refusing to substitute <${key}> in ${rel}: no value was supplied for it`,
        );
        error.code = MISSING_TOKEN;
        error.token = key;
        error.rel = rel;
        throw error;
      }
      count += 1;
      return values[key];
    });
    if (after !== before) writeFileSync(path, after, 'utf8');
  }
  return count;
}

export function scaffold(templatesRoot, type, destDir, values) {
  // First statement, before the profile lookup and before any mkdir: a refusal must
  // cost the caller nothing. Profile validation follows, so an unknown type also
  // leaves a missing destination missing.
  assertEmptyDest(destDir);

  const profileDir = join(templatesRoot, 'profiles', type);
  if (!existsSync(profileDir)) throw new Error(`unknown profile type: ${type}`);

  const meta = parseProfileMeta(readFileSync(join(profileDir, 'profile.md'), 'utf8'));
  if (!meta) throw new Error(`profiles/${type}/profile.md has no usable \`\`\`profile block`);

  mkdirSync(destDir, { recursive: true });

  const base = applyLayer(join(templatesRoot, 'base'), destDir);
  const overlay = applyLayer(profileDir, destDir);
  if (overlay.skipped.length) {
    throw new Error(
      `profile collides with base on: ${overlay.skipped.join(', ')} — ` +
      'move the intended replacements to files-override/',
    );
  }

  // Built before substitution because it is now also the substitution scope, not
  // only the provenance input. One map, one source of truth for "what did we write";
  // a second hand-maintained list would drift from this one silently.
  //
  // Layer and mode are carried per file because /sync-standards (Phase 6) must
  // never push a base update into a file a profile overrode or merely appended
  // to. The profile layer is recorded second so it wins on any shared path.
  const record = (result, layer) => [
    ...result.copied.map((rel) => ({ rel, layer, mode: 'copied' })),
    ...result.appended.map((rel) => ({ rel, layer, mode: 'appended' })),
    ...result.overridden.map((rel) => ({ rel, layer, mode: 'overridden' })),
  ];
  const written = new Map(
    [...record(base, 'base'), ...record(overlay, 'profile')].map((e) => [e.rel, e]),
  );

  // No coercion. `String(undefined)` produced the five-letter string "undefined",
  // which reaches fillPlaceholders as data and substitutes as cleanly as a real
  // year would; the declared-missing value has to survive as `undefined` to reach
  // the gate at all. Computed once so the manifest below records the same thing
  // the files were composed from.
  const year = values.year === undefined || values.year === null
    ? undefined
    : String(values.year);

  // CLAUDE.md is a base-layer path, so fragment injection stays inside the scope.
  injectFragments(destDir, profileDir);
  fillPlaceholders(destDir, {
    YEAR: year,
    VERIFY_COMMAND: meta.verify,
    TEST_COMMAND: meta.test,
    DEPLOY_COMMAND: meta.deploy,
    ...values.tokens,
  }, written.keys());

  // After substitution, before verification: the digests must describe the repo
  // as it will be committed, and the verifier must see the finished tree.
  const provenance = buildProvenance({
    root: destDir,
    version: JSON.parse(readFileSync(join(templatesRoot, 'package.json'), 'utf8')).version,
    profile: type,
    tokens: { YEAR: year, ...values.tokens },
    files: [...written.values()],
  });
  // Create-only: an initial scaffold has no manifest to replace, so a manifest that
  // appeared during the run belongs to someone else. A refusal here leaves the
  // written files for inspection — restoring the prior tree would mean proving
  // ownership of every path now in it, which this operation cannot do.
  writeProvenance(destDir, provenance, { create: true });

  return {
    docsSubdirs: meta.docsSubdirs,
    provenance,
    violations: verifyRepo(destDir, { docsSubdirs: meta.docsSubdirs }),
  };
}

function main(argv) {
  const args = argv.slice(2);
  const [root, type, dest] = args.filter((a) => !a.startsWith('--'));
  const flag = (key) => (args.find((a) => a.startsWith(`--${key}=`)) ?? '').split('=').slice(1).join('=');
  if (!root || !type || !dest || !flag('name') || !flag('summary')) {
    console.error('usage: node scripts/scaffold.mjs <templates-root> <type> <dest> --name=<n> --summary=<s>');
    return 2;
  }
  // Only the operational call is wrapped, and only to turn an expected refusal into
  // an operator-readable line instead of a stack trace. scaffold() keeps throwing, so
  // programmatic callers and tests still get the whole error object. Usage stays 2.
  let violations;
  try {
    ({ violations } = scaffold(root, type, dest, {
      year: new Date().getFullYear(),
      tokens: { PROJECT_NAME: flag('name'), PROJECT_SUMMARY: flag('summary') },
    }));
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  for (const v of violations) console.error(`${v.rule}: ${v.path} — ${v.message}`);
  if (violations.length) {
    // No deletion command, conditional or otherwise. The old hint authored a
    // recursive force-delete of a directory this process does not own — and a
    // .git-only destination reaches this branch with the operator's .git in it.
    console.error(`\nscaffold is incomplete. Inspect ${dest} — nothing was cleaned up.`);
    return 1;
  }
  console.log(`scaffolded ${flag('name')} (${type}) at ${dest} — clean`);
  return 0;
}

export { main };
runCli(import.meta.url, main);
