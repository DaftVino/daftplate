#!/usr/bin/env node
// Verifies a repository against engineering-standards/repo-standards.md.
// Usage: node scripts/verify-repo.mjs <repo-path> [--docs-subdirs=designs,adr]
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { violation, reportViolations, runCli } from './lib/cli.mjs';
import { walkFiles, EXCLUDED_DIRS } from './lib/fs.mjs';

// Re-exported so existing importers of the verifier keep working.
export { walkFiles, EXCLUDED_DIRS };

export const REQUIRED_ROOT_FILES = ['README.md', 'LICENSE', 'CHANGELOG.md', 'CLAUDE.md', '.gitignore'];

export const ALLOWED_UPPERCASE_ROOT = [
  'README.md', 'LICENSE', 'CHANGELOG.md', 'CLAUDE.md',
  'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'AGENTS.md',
];

// Gitignored configs that must have a committed sanitized twin (repo-standards §2.1).
export const SECRET_CONFIGS = ['.env', '.clasp.json', '.dev.vars'];

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.example',
]);

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)*$/;

export function checkRootFiles(dir) {
  return REQUIRED_ROOT_FILES
    .filter((name) => !existsSync(join(dir, name)))
    .map((name) => violation('root-files', name, 'required root file is missing'));
}

export function checkRootNaming(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && lstatSync(join(dir, name)).isFile())
    .filter((name) => !ALLOWED_UPPERCASE_ROOT.includes(name) && !KEBAB.test(name))
    .map((name) => violation('naming', name, 'root file must be lowercase-kebab or a canonical uppercase file'));
}

export function checkDocsNaming(dir) {
  return walkFiles(join(dir, 'docs'), 'docs')
    .filter(({ rel }) => !KEBAB.test(rel.split('/').pop()))
    .map(({ rel }) => violation('naming', rel, 'everything under docs/ must be lowercase-kebab'));
}

export function checkDocsSubdirs(dir, allowed = ['designs', 'adr']) {
  const docs = join(dir, 'docs');
  if (!existsSync(docs)) return [];
  return readdirSync(docs)
    .filter((name) => lstatSync(join(docs, name)).isDirectory() && !allowed.includes(name))
    .map((name) => violation('docs-layout', `docs/${name}`, `docs/ is flat except ${allowed.join(', ')}`));
}

export function checkClaudeMdLength(dir, max = 60) {
  const path = join(dir, 'CLAUDE.md');
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).length;
  return lines <= max
    ? []
    : [violation('claude-md-length', 'CLAUDE.md', `${lines} lines; CLAUDE.md is a router, keep it under ${max}`)];
}

function isTextFile(name) {
  if (name.startsWith('.')) return true;               // dotfiles: .gitignore, .env.example
  const dot = name.lastIndexOf('.');
  if (dot === -1) return true;                          // LICENSE, Makefile
  return TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

export function checkNoVendoredStandards(dir) {
  return existsSync(join(dir, 'engineering-standards'))
    ? [violation('vendored-standards', 'engineering-standards', 'standards are canonical in daftplate; keep a pointer, not a copy (ADR 0001)')]
    : [];
}

export function checkExampleTwins(dir) {
  const gitignore = join(dir, '.gitignore');
  if (!existsSync(gitignore)) return [];
  const ignored = new Set(readFileSync(gitignore, 'utf8').split(/\r?\n/).map((line) => line.trim()));
  return SECRET_CONFIGS
    .filter((name) => ignored.has(name) && !existsSync(join(dir, `${name}.example`)))
    .map((name) => violation('example-twin', `${name}.example`, `${name} is gitignored but has no committed .example twin`));
}

export function checkNoUnresolvedPlaceholders(dir) {
  return walkFiles(dir)
    .filter(({ rel, isDir }) => !isDir && isTextFile(rel.split('/').pop()))
    .flatMap(({ rel }) => {
      const text = readFileSync(join(dir, rel), 'utf8');
      return [
        ...[...text.matchAll(/<!-- profile:[a-z]+ -->/g)]
          .map((m) => violation('placeholders', rel, `unresolved profile marker ${m[0]}`)),
        ...[...text.matchAll(/<[A-Z][A-Z_]{2,}>/g)]
          .map((m) => violation('placeholders', rel, `unresolved placeholder ${m[0]}`)),
      ];
    });
}

export function verifyRepo(dir, opts = {}) {
  return [
    ...checkRootFiles(dir),
    ...checkRootNaming(dir),
    ...checkDocsNaming(dir),
    ...checkDocsSubdirs(dir, opts.docsSubdirs),
    ...checkClaudeMdLength(dir),
    ...checkNoVendoredStandards(dir),
    ...checkExampleTwins(dir),
    ...checkNoUnresolvedPlaceholders(dir),
  ];
}

function main(argv) {
  const args = argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('usage: node scripts/verify-repo.mjs <repo-path> [--docs-subdirs=designs,adr]');
    return 2;
  }
  const subdirsArg = args.find((a) => a.startsWith('--docs-subdirs='));
  const opts = subdirsArg ? { docsSubdirs: subdirsArg.split('=')[1].split(',') } : {};
  return reportViolations(verifyRepo(target, opts));
}

export { main };
runCli(import.meta.url, main);
