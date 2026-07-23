#!/usr/bin/env node
// Verifies that the template layers in this repo are complete and well-formed.
// Usage: node scripts/verify-templates.mjs <templates-root>
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { violation, reportViolations, runCli } from './lib/cli.mjs';

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

function overrideTargets(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return lstatSync(join(dir, name)).isDirectory() ? overrideTargets(join(dir, name), rel) : [rel];
  });
}

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
      for (const rel of overrideTargets(join(profiles, name, 'files-override'))) {
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

export function verifyTemplates(root) {
  return [...checkBase(root), ...checkProfiles(root)];
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
