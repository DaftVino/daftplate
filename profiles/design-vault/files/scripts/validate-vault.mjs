#!/usr/bin/env node
// Validates a design vault: bucket layout, note frontmatter, internal links.
//
// This file ships INTO the scaffolded repo, which has no daftplate checkout, so
// it imports nothing but node: builtins. The small duplication of the violation
// shape and the tree walk is the price of being runnable where it lands.
//
// I/O shape is deliberately simple, not optimized: validateVault walks the tree
// twice and reads every note twice (checkFrontmatter, then checkLinks). Measured
// against a real multi-hundred-note vault this is tens of milliseconds, and
// the plain shape is worth more than the saving in the repos this runs in. A
// future session hitting a genuinely slow vault should start from that fact.
//
// Usage: node scripts/validate-vault.mjs [vault-root]
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The numbered scheme, canonicalized lowercase from a private design vault. Edit this list
// in your own repo if your vault uses named buckets (as some vaults
// do) — it is a constant here so that editing it is a reviewed one-line diff,
// not a configuration format nobody maintains.
export const VAULT_BUCKETS = [
  '00-project', '10-world', '20-design', '30-content',
  '40-research', '50-technical', '90-production', 'designs', 'adr',
];

const EXCLUDED_DIRS = new Set(['.git', '.obsidian', 'node_modules']);

const violation = (rule, path, message) => ({ rule, path, message });

/** Depth-first list of markdown files under `dir`, as POSIX paths prefixed by `prefix`. */
export function notes(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const stats = lstatSync(full);
    if (stats.isSymbolicLink()) return [];
    const rel = prefix ? `${prefix}/${name}` : name;
    if (stats.isDirectory()) return EXCLUDED_DIRS.has(name) ? [] : notes(full, rel);
    return name.endsWith('.md') ? [rel] : [];
  });
}

export function checkBuckets(root) {
  const docs = join(root, 'docs');
  if (!existsSync(docs)) return [];
  return readdirSync(docs)
    .filter((name) => lstatSync(join(docs, name)).isDirectory())
    .filter((name) => !VAULT_BUCKETS.includes(name))
    .map((name) => violation(
      'bucket',
      `docs/${name}`,
      `not a vault bucket — allowed: ${VAULT_BUCKETS.join(', ')}`,
    ));
}

// These two buckets hold process docs — ADRs and design plans — which keep their
// own formats and carry no title/updated frontmatter. Files sitting directly
// under docs/ (docs/architecture.md, docs/quick-ref-workflow.md) are base
// scaffolding, not vault content. A vault NOTE is content: it lives inside a
// content bucket. Only those are checked for frontmatter and links.
const PROCESS_BUCKETS = new Set(['designs', 'adr']);

function contentNotes(root) {
  return notes(join(root, 'docs'), 'docs').filter((rel) => {
    const parts = rel.split('/'); // ['docs', bucket, ...file]
    return parts.length > 2 && !PROCESS_BUCKETS.has(parts[1]);
  });
}

export const REQUIRED_FIELDS = ['title', 'updated'];

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

export function checkFrontmatter(root) {
  return contentNotes(root).flatMap((rel) => {
    const parsed = parseFrontmatter(readFileSync(join(root, rel), 'utf8'));
    if (!parsed) return [violation('frontmatter', rel, 'note has no --- frontmatter block')];
    const { values, structured } = parsed;
    return [
      ...REQUIRED_FIELDS.filter((f) => !(f in values)).map((f) => violation('frontmatter', rel,
        structured.has(f)
          ? `${f} must be a single-line \`${f}: value\`, not a list or multiline value`
          : `frontmatter is missing ${f}`)),
      ...(values.updated && !ISO_DATE.test(values.updated)
        ? [violation('frontmatter', rel, `updated must be YYYY-MM-DD, got "${values.updated}"`)] : []),
    ];
  });
}

// [[target]], [[target|alias]], [[target#heading]] and markdown [text](target).
// Obsidian resolves by note stem regardless of folder, so both forms match that
// behaviour rather than paths. A fenced code block documents syntax rather than
// using it, so it is stripped before scanning; external and in-page targets are
// left alone.
const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const MDLINK = /\[[^\]]*\]\(([^)\s]+?)(?:#[^)\s]*)?\)/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

const stripFences = (text) => text.replace(/^```[\s\S]*?^```/gm, '');
const stem = (target) => target.split('/').pop().replace(/\.md$/, '').trim();

export function checkLinks(root) {
  const stems = new Set(notes(join(root, 'docs'), 'docs').map(stem));
  return contentNotes(root).flatMap((rel) => {
    const text = stripFences(readFileSync(join(root, rel), 'utf8'));
    const targets = [
      ...[...text.matchAll(WIKILINK)].map((m) => m[1]),
      ...[...text.matchAll(MDLINK)].map((m) => m[1]),
    ];
    return targets
      .map((target) => target.trim())
      .filter((target) => target && !EXTERNAL.test(target) && !stems.has(stem(target)))
      .map((target) => violation('link', rel, `[[${target}]] resolves to no note in the vault — report it, do not repair the record`));
  });
}

export function validateVault(root) {
  return [...checkBuckets(root), ...checkFrontmatter(root), ...checkLinks(root)];
}

function main(argv) {
  const root = argv[2] ?? '.';
  const violations = validateVault(root);
  for (const v of violations) console.error(`${v.rule}: ${v.path} — ${v.message}`);
  console.log(violations.length ? `${violations.length} violation(s)` : 'clean');
  return violations.length ? 1 : 0;
}

export { main };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
