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
  'ROADMAP.md',
];

// Gitignored configs that must have a committed sanitized twin (repo-standards §2.1).
export const SECRET_CONFIGS = ['.env', '.clasp.json', '.dev.vars'];

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.example',
]);

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)*$/;

// Ecosystem root files a toolchain looks up by exact name: Dockerfile, Makefile,
// Procfile, Justfile, Gemfile, Rakefile, Jenkinsfile, Caddyfile. Docker finds no
// default without -f, so renaming one to satisfy a style rule breaks the build —
// the rule has to bend, not the filename.
//
// Matched by SHAPE, not by a list. An enumeration institutionalizes its own
// staleness: the next convention arrives and the checker is wrong again until
// someone edits it. `Widgetfile` passing is the evidence the rule is structural.
//
// Deliberately narrower than "extensionless TitleCase", which would also admit
// `Readme` beside a correct `README.md`. The stem must be an uppercase letter,
// then lowercase or digits, then a lowercase `file` — so `DockerFile` is still a
// violation. An optional variant suffix is lowercase-kebab, for `Dockerfile.prod`
// and `Dockerfile.prod-us`, so `Dockerfile.Prod` is still a violation.
//
// The stated cost: `Readmefile` passes. That is the price of a shape rule, and it
// is recorded rather than hidden behind well-chosen examples.
const TOOL_ROOT_FILE = /^[A-Z][a-z0-9]*file(\.[a-z0-9]+(-[a-z0-9]+)*)?$/;

export function checkRootFiles(dir) {
  return REQUIRED_ROOT_FILES
    .filter((name) => !existsSync(join(dir, name)))
    .map((name) => violation('root-files', name, 'required root file is missing'));
}

export function checkRootNaming(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && lstatSync(join(dir, name)).isFile())
    .filter((name) => !ALLOWED_UPPERCASE_ROOT.includes(name)
      && !KEBAB.test(name)
      && !TOOL_ROOT_FILE.test(name))
    .map((name) => violation(
      'naming',
      name,
      'root file must be lowercase-kebab, a canonical uppercase file, or an ecosystem *file name',
    ));
}

export function checkDocsNaming(dir) {
  return walkFiles(join(dir, 'docs'), 'docs')
    .filter(({ rel }) => !KEBAB.test(rel.split('/').pop()))
    .map(({ rel }) => violation('naming', rel, 'everything under docs/ must be lowercase-kebab'));
}

// Allowed in every repo whatever its profile. `records/` joins designs/ and adr/
// because skills that emit durable records — /deliberate writes
// docs/records/deliberate/YYYY-MM-DD-slug.md — need a home that does not depend
// on which profile produced the repo. A profile's `docs-subdirs` EXTENDS this
// set rather than replacing it: every profile already restates "designs, adr",
// and a profile that forgot to restate a universal bucket would otherwise have
// its own skill output flagged as a layout violation.
export const UNIVERSAL_DOCS_SUBDIRS = ['designs', 'adr', 'records'];

export function checkDocsSubdirs(dir, extra = []) {
  const docs = join(dir, 'docs');
  if (!existsSync(docs)) return [];
  const allowed = [...new Set([...UNIVERSAL_DOCS_SUBDIRS, ...extra])];
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
        // Standalone only. `<<<UNTRUSTED_SOURCE_TEXT>>>` is a prompt-injection
        // delimiter marking where untrusted scraped text begins inside an LLM
        // prompt — measured on one repo, 12 of 19 findings were that pair. The
        // old rule called them placeholders and the remedy it implied was
        // "resolve them", i.e. delete a trust boundary in an AI application.
        //
        // Both guards are load-bearing and neither is redundant: a fully
        // symmetric `<<<X>>>` is suppressed by either one alone, so only the
        // asymmetric `<<X>` and `<X>>` cases prove both are present.
        //
        // Not an assignment or quoted-value exemption, which #109 proposed: that
        // would also exempt a genuine scaffold token in a string or a config,
        // which is exactly where an unsubstituted one hides.
        ...[...text.matchAll(/(?<!<)<[A-Z][A-Z_]{2,}>(?!>)/g)]
          .map((m) => violation(
            'placeholders',
            rel,
            `possible unresolved template placeholder ${m[0]}; `
            + 'verify it is a scaffold token before replacing it',
          )),
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
