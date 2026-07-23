#!/usr/bin/env node
// Validates a content library and generates its index.
//
// Ships INTO the scaffolded repo, which has no daftplate checkout, so it imports
// nothing but node: builtins. Its sibling is design-vault's validate-vault.mjs;
// the two deliberately do not share a module, because a shared module would have
// to be vendored into both repos. Keep parseFrontmatter in step with that file —
// the frontmatter contract region below is byte-identical to it, and a test in
// daftplate fails if the two drift.
//
// Usage: node scripts/validate-library.mjs [root] [--write-index]
import { existsSync, readdirSync, readFileSync, writeFileSync, lstatSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIBRARY_ROOT = 'library';
export const ITEM_FIELDS = ['title', 'category', 'summary', 'updated'];

const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

const violation = (rule, path, message) => ({ rule, path, message });

/** Every markdown item under library/, as POSIX paths, sorted. */
export function items(root, dir = LIBRARY_ROOT) {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .flatMap((name) => {
      const stats = lstatSync(join(full, name));
      const rel = `${dir}/${name}`;
      if (stats.isSymbolicLink()) return [];
      if (stats.isDirectory()) return EXCLUDED_DIRS.has(name) ? [] : items(root, rel);
      return name.endsWith('.md') ? [rel] : [];
    })
    .sort();
}

// Frontmatter contract, deliberately narrow and stated in profile.md and the
// CLAUDE.md fragment so the boundary is documented rather than discovered:
//   REQUIRED fields must be a single-line `key: value`, optionally quoted.
// Everything else in the block — block lists (`tags:` then `- item`), inline
// lists (`aliases: [a, b]`), comments — is OPTIONAL structure this validator
// does not check, so it is skipped, never failed on. A required field written
// as a list or across multiple lines is the one case that fails, loudly and by
// name, because that is a field we genuinely cannot read.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function unquote(raw) {
  const q = raw[0];
  return raw.length >= 2 && (q === '"' || q === "'") && raw.at(-1) === q ? raw.slice(1, -1) : raw;
}

export function parseFrontmatter(text) {
  const block = text.match(FRONTMATTER);
  if (!block) return null;

  const values = {};            // scalar key -> value, the only thing we validate
  const structured = new Set(); // keys present but written as a list/empty — skipped, tracked for a better message

  for (const line of block[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue; // blank / comment
    if (/^\s+-\s/.test(line)) continue;                        // list item — belongs to a key already in `structured`
    const pair = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!pair) continue;                                       // anything else we don't check — ignore, do not fail
    const [, key, rest] = pair;
    const raw = rest.trim();
    if (raw === '' || (raw.startsWith('[') && raw.endsWith(']'))) { structured.add(key); continue; } // block/inline list
    values[key] = unquote(raw);
  }

  return { values, structured };
}

export function checkItems(root) {
  return items(root).flatMap((rel) => {
    const parts = rel.split('/');
    if (parts.length !== 3) {
      return [violation('layout', rel, `items live at ${LIBRARY_ROOT}/<category>/<item>.md`)];
    }
    const parsed = parseFrontmatter(readFileSync(join(root, rel), 'utf8'));
    if (!parsed) return [violation('frontmatter', rel, 'item has no --- frontmatter block')];
    const { values, structured } = parsed;

    return [
      ...ITEM_FIELDS.filter((f) => !(f in values)).map((f) => violation('frontmatter', rel,
        structured.has(f)
          ? `${f} must be a single-line \`${f}: value\`, not a list or multiline value`
          : `frontmatter is missing ${f}`)),
      ...(values.updated && !ISO_DATE.test(values.updated)
        ? [violation('frontmatter', rel, `updated must be YYYY-MM-DD, got "${values.updated}"`)] : []),
      ...(values.category && values.category !== parts[1]
        ? [violation('category', rel, `frontmatter says "${values.category}" but the item sits in "${parts[1]}"`)] : []),
    ];
  });
}

export const INDEX_PATH = 'docs/library-index.md';

// Deterministic by construction: items() sorts, categories sort, and nothing
// derived from the clock or from readdir order reaches the output. CI compares
// the committed file against this, and a generator that drifts trains everyone
// to ignore the check.
export function buildIndex(root) {
  const byCategory = new Map();
  for (const rel of items(root)) {
    const parts = rel.split('/');
    if (parts.length !== 3) continue;
    const values = parseFrontmatter(readFileSync(join(root, rel), 'utf8'))?.values ?? {};
    const entry = `- [${values.title ?? parts[2].replace(/\.md$/, '')}](../${rel}) — ${values.summary ?? ''}`;
    if (!byCategory.has(parts[1])) byCategory.set(parts[1], []);
    byCategory.get(parts[1]).push(entry);
  }

  const lines = [
    '# Library index',
    '',
    'Generated by `node scripts/validate-library.mjs --write-index`. Do not edit by hand.',
    '',
  ];
  for (const category of [...byCategory.keys()].sort()) {
    lines.push(`## ${category}`, '', ...byCategory.get(category).sort(), '');
  }
  return lines.join('\n');
}

export function checkIndex(root) {
  const path = join(root, INDEX_PATH);
  const expected = buildIndex(root);
  if (!existsSync(path)) {
    return [violation('index-missing', INDEX_PATH, 'no index — run `node scripts/validate-library.mjs --write-index`')];
  }
  return readFileSync(path, 'utf8') === expected
    ? []
    : [violation('index-stale', INDEX_PATH, 'index does not match the library — run `node scripts/validate-library.mjs --write-index`')];
}

export function validateLibrary(root, opts = {}) {
  if (opts.write) {
    const path = join(root, INDEX_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buildIndex(root), 'utf8');
  }
  return [...checkItems(root), ...checkIndex(root)];
}

function main(argv) {
  const args = argv.slice(2);
  const root = args.find((a) => !a.startsWith('--')) ?? '.';
  const violations = validateLibrary(root, { write: args.includes('--write-index') });
  for (const v of violations) console.error(`${v.rule}: ${v.path} — ${v.message}`);
  console.log(violations.length ? `${violations.length} violation(s)` : 'clean');
  return violations.length ? 1 : 0;
}

export { main };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
