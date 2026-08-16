#!/usr/bin/env node
// Verifies that the template layers in this repo are complete and well-formed.
// Usage: node scripts/verify-templates.mjs <templates-root>
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { violation, reportViolations, runCli } from './lib/cli.mjs';
import { walkFiles } from './lib/fs.mjs';

export const REQUIRED_BASE_FILES = [
  'base.md',
  'files/README.md',
  'files/LICENSE',
  'files/CHANGELOG.md',
  'files/CLAUDE.md',
  'files/dot-gitignore',
  'files/dot-gitattributes',
  'files/dot-editorconfig',
  'files/dot-env.example',
  'files/dot-claude/settings.json',
  'files/dot-claude/orient-hook.mjs',
  'files/dot-claude/question-gate.mjs',
  'files/dot-github/ISSUE_TEMPLATE/bug-report.yml',
  'files/dot-github/ISSUE_TEMPLATE/feature-request.yml',
  'files/dot-github/PULL_REQUEST_TEMPLATE.md',
  'files/dot-github/workflows/ci.yml',
  'files/dot-github/dependabot.yml',
  'files/docs/architecture.md',
  'files/docs/quick-ref-workflow.md',
];

export const REQUIRED_PROFILE_FILES = [
  'profile.md', 'claude-md-fragment.md', 'skill-routing.md', 'context-rules.md',
];

export const REQUIRED_HEADINGS = {
  'skill-routing.md': ['## Pipeline', '## Off'],
  'context-rules.md': ['## Context budget', '## Subagent defaults'],
};

export const REQUIRED_META_KEYS = ['verify', 'test', 'deploy', 'docs-subdirs'];

export const CLAUDE_MD_MARKERS = [
  '<!-- profile:constraints -->', '<!-- profile:routing -->', '<!-- profile:context -->',
];

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Reads the fenced ```profile block out of a profile.md. Returns null if absent or incomplete. */
export function parseProfileMeta(text) {
  const block = text.match(/```profile\r?\n([\s\S]*?)```/);
  if (!block) return null;
  const entries = Object.fromEntries(
    block[1].split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const colon = line.indexOf(':');
        return colon === -1 ? null : [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
      })
      .filter(Boolean),
  );
  if (REQUIRED_META_KEYS.some((key) => !entries[key])) return null;
  return {
    verify: entries.verify,
    test: entries.test,
    deploy: entries.deploy,
    docsSubdirs: entries['docs-subdirs'].split(',').map((s) => s.trim()).filter(Boolean),
  };
}

// A profile.md metadata value is read BEFORE substitution and then used AS a
// substitution value. fillPlaceholders makes one String.replace pass and JS
// does not re-scan replacement text, so a token inside a value survives into
// the scaffolded CLAUDE.md and fails verifyRepo from a file that looks blameless.
const TOKEN_IN_VALUE = /<[A-Z][A-Z_]{2,}>/;

// `npm test` running bare `node --test` is the only correct value for a Node repo
// here. Every positional argument after --test is wrong on some supported version:
// a directory is a glob that matches nothing on 22+ (measured on v24.16.0), and an
// expanded glob breaks CI's Node 20. Checked against all seven profiles: every one
// is `npm test` or `n/a`, so there is no false positive to design around.
const TEST_POSITIONAL = /^node\s+--test\s+\S/;

// A metadata value naming scripts/<file> is a promise the overlay has to keep:
// it is the first command a fresh repo's CLAUDE.md names, and a missing target
// exits MODULE_NOT_FOUND. Only checked when the profile directory is known.
const SCRIPT_REF = /(?:^|\s)(scripts\/[A-Za-z0-9._-]+)/;

export function metaValueIssues(meta, rel, profileDir) {
  const issues = [];
  for (const key of ['verify', 'test', 'deploy']) {
    const match = meta[key].match(TOKEN_IN_VALUE);
    if (match) {
      issues.push(violation(
        'profile-metadata-token',
        rel,
        `${key} contains ${match[0]}; a metadata value is itself a substitution value and is not substituted a second time`,
      ));
    }
  }
  if (TEST_POSITIONAL.test(meta.test)) {
    issues.push(violation(
      'profile-metadata-test-form',
      rel,
      `test: "${meta.test}" runs nothing — the positional arg is a glob on Node 22+. Use "npm test" with package.json running bare "node --test".`,
    ));
  }
  if (profileDir) {
    for (const key of ['verify', 'test', 'deploy']) {
      const ref = meta[key].match(SCRIPT_REF);
      if (ref && !existsSync(join(profileDir, 'files', ref[1]))) {
        issues.push(violation(
          'profile-metadata-missing-script',
          rel,
          `${key} names ${ref[1]}, which this profile does not ship — add it to files/, or use a command that works in a fresh repo`,
        ));
      }
    }
  }
  return issues;
}

export function checkBase(root) {
  const violations = [];
  for (const rel of REQUIRED_BASE_FILES) {
    const path = join(root, 'base', rel);
    if (!existsSync(path)) {
      violations.push(violation('base-files', `base/${rel}`, 'required base file is missing'));
    } else if (readFileSync(path, 'utf8').trim() === '') {
      violations.push(violation('base-empty', `base/${rel}`, 'required base file is empty'));
    }
  }
  const claudeMd = join(root, 'base', 'files', 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const text = readFileSync(claudeMd, 'utf8');
    for (const marker of CLAUDE_MD_MARKERS) {
      if (!text.includes(marker)) {
        violations.push(violation('base-markers', 'base/files/CLAUDE.md', `base CLAUDE.md is missing marker ${marker}`));
      }
    }
  }
  return violations;
}

const filesUnder = (dir) => walkFiles(dir).filter((e) => !e.isDir).map((e) => e.rel);

export function checkProfiles(root) {
  const profiles = join(root, 'profiles');
  if (!existsSync(profiles)) return [violation('profiles-missing', 'profiles', 'no profiles directory')];

  return readdirSync(profiles)
    .filter((name) => lstatSync(join(profiles, name)).isDirectory())
    .flatMap((name) => {
      const violations = KEBAB.test(name)
        ? []
        : [violation('profile-naming', `profiles/${name}`, 'profile directory must be lowercase-kebab')];

      for (const file of REQUIRED_PROFILE_FILES) {
        const rel = `profiles/${name}/${file}`;
        const path = join(profiles, name, file);
        if (!existsSync(path)) {
          violations.push(violation('profile-files', rel, 'required profile file is missing'));
          continue;
        }
        const text = readFileSync(path, 'utf8');
        if (text.trim() === '') {
          violations.push(violation('profile-empty', rel, 'required profile file is empty'));
          continue;
        }
        for (const heading of REQUIRED_HEADINGS[file] ?? []) {
          if (!text.includes(heading)) {
            violations.push(violation('profile-headings', rel, `${rel} is missing heading "${heading}"`));
          }
        }
        if (file === 'profile.md') {
          const meta = parseProfileMeta(text);
          if (!meta) {
            violations.push(violation('profile-metadata', rel, `profile.md needs a \`\`\`profile block with ${REQUIRED_META_KEYS.join(', ')}`));
          } else {
            violations.push(...metaValueIssues(meta, rel, join(profiles, name)));
          }
        }
      }

      // A files-override entry must actually replace something the base layer writes.
      for (const rel of filesUnder(join(profiles, name, 'files-override'))) {
        if (!existsSync(join(root, 'base', 'files', rel))) {
          violations.push(violation(
            'override-unnecessary',
            `profiles/${name}/files-override/${rel}`,
            'files-override/ is for replacing base files; this replaces nothing — move it to files/',
          ));
        }
      }
      return violations;
    });
}

// --- Workflow supply-chain lint -------------------------------------------
//
// These patterns are regex over raw text rather than a YAML parse, because
// CLAUDE.md constraint #4 forbids dependencies outright and hand-rolling a YAML
// parser for a lint would be absurd. That is defensible for this input in
// particular: `uses:` takes a scalar string, and "is this forty hex characters"
// survives any representation this repo would actually write; the corpus is
// closed and small — the workflow files this repo authors, every one reviewed in
// a PR — not arbitrary user YAML; and `setup-repo.mjs:122` already derives
// required check contexts by regex over these same files, in a path that can
// permanently break branch protection when it is wrong. A lint is a strictly
// safer home for the technique than the code that already ships it.
//
// Two known blind spots, both of which fail open on one line while every other
// rule still holds: a quoted scalar (`uses: "actions/checkout@v4"`) is not
// matched, and neither is a `uses:` carried inside a block scalar as data.
// Nothing in this corpus writes either. A false positive — the dangerous
// direction for a gate — needs a literal `uses:` key at the start of a line, so
// it cannot arise from prose.

const WORKFLOW_FILE = /\.ya?ml$/;
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(\S+)[^\S\n]*(#.*)?$/;
const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const PINNED_DOCKER = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;
const LOCAL_ACTION = /^\.{1,2}\//;
const VERSION_COMMENT = /^#\s*v\d/;

const DOWNLOADER = /\b(?:curl|wget)\b/;
const PIPED_DOWNLOAD = /\b(?:curl|wget)\b.*\|\s*(?:tar|sh|bash|zsh|python3?)\b/;

// The trust anchor is the committed literal, not the vocabulary. Requiring only
// that `sha256sum -c` appear would pass a workflow that fetches the checksums
// file from the same release, over the same channel, at the same moment as the
// artifact — which verifies nothing, since whoever can alter the tarball can
// alter the checksums beside it. So a download has to name an `env:` key whose
// value is a full 64-hex digest sitting in the reviewed file.
const ENV_DIGEST = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*['"]?([0-9a-f]{64})['"]?\s*$/;

/** Every workflow file this repo authors: the base template, both profile layers, and its own live CI. */
export function workflowFiles(root) {
  const dirs = ['.github/workflows', 'base/files/dot-github/workflows'];
  const profiles = join(root, 'profiles');
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      if (!lstatSync(join(profiles, name)).isDirectory()) continue;
      // files-override/ carries no workflow today. It is scanned anyway: an
      // override is the one mechanism designed to replace a base file, and so
      // the one place a hardened base rule would get quietly reverted.
      dirs.push(`profiles/${name}/files/dot-github/workflows`);
      dirs.push(`profiles/${name}/files-override/dot-github/workflows`);
    }
  }
  return dirs.flatMap((dir) => walkFiles(join(root, dir))
    .filter((entry) => !entry.isDir && WORKFLOW_FILE.test(entry.rel))
    .map((entry) => `${dir}/${entry.rel}`));
}

/** `env:` keys whose value is a full 64-hex digest — the only values that can anchor a download. */
function envDigestKeys(text) {
  const lines = text.split(/\r?\n/);
  const keys = new Set();
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)env:\s*$/);
    if (!open) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      if (lines[j].match(/^\s*/)[0].length <= open[1].length) break;
      const entry = lines[j].match(ENV_DIGEST);
      if (entry) keys.add(entry[1]);
    }
  }
  return [...keys];
}

/** Each `run:` script: the key's own line plus every following line indented past it. */
function runBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*(?:-\s+)?)run:(.*)$/);
    if (!open) continue;
    const column = open[1].length;
    const body = [open[2].replace(/^\s*[|>][-+\d]*\s*/, '').trim()];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim() === '') { body.push(''); continue; }
      if (lines[j].match(/^\s*/)[0].length <= column) break;
      body.push(lines[j].trim());
    }
    blocks.push({ line: i + 1, text: body.join('\n') });
    i = j - 1;
  }
  return blocks;
}

export function checkWorkflows(root) {
  return workflowFiles(root).flatMap((rel) => {
    const text = readFileSync(join(root, rel), 'utf8');
    const violations = [];

    for (const line of text.split(/\r?\n/)) {
      const used = line.match(USES_LINE);
      if (!used) continue;
      const [, ref, comment] = used;
      if (LOCAL_ACTION.test(ref)) continue;
      if (!PINNED_ACTION.test(ref) && !PINNED_DOCKER.test(ref)) {
        violations.push(violation(
          'workflow-unpinned-action',
          rel,
          `uses: ${ref} — pin to a full 40-character commit SHA (or docker://…@sha256:<64 hex>); a tag or branch is mutable and can be repointed after review`,
        ));
        continue;
      }
      if (!VERSION_COMMENT.test(comment ?? '')) {
        violations.push(violation(
          'workflow-missing-version-comment',
          rel,
          `uses: ${ref} has no trailing "# vX.Y.Z" — the SHA alone tells a reader nothing about what is pinned, and Dependabot rewrites that comment when it bumps the pin`,
        ));
      }
    }

    const digests = envDigestKeys(text);
    for (const block of runBlocks(text)) {
      for (const [offset, line] of block.text.split('\n').entries()) {
        if (!PIPED_DOWNLOAD.test(line)) continue;
        violations.push(violation(
          'workflow-piped-download',
          rel,
          `line ${block.line + offset}: a download piped straight into an extractor or a shell executes bytes that were never a file, so nothing can verify them first`,
        ));
      }
      if (!DOWNLOADER.test(block.text)) continue;
      if (digests.some((key) => new RegExp(`\\$\\{?${key}\\b`).test(block.text))) continue;
      violations.push(violation(
        'workflow-unverified-download',
        rel,
        `line ${block.line}: this run: block downloads something without checking it against a committed 64-hex digest held in a workflow env: key`,
      ));
    }

    return violations;
  });
}

export function verifyTemplates(root) {
  return [...checkBase(root), ...checkProfiles(root), ...checkWorkflows(root)];
}

function main(argv) {
  const root = argv[2];
  if (!root) {
    console.error('usage: node scripts/verify-templates.mjs <templates-root>');
    return 2;
  }
  return reportViolations(verifyTemplates(root));
}

export { main };
runCli(import.meta.url, main);
