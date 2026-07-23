#!/usr/bin/env node
// Composes base + profile into a destination repo and substitutes the templates.
// Usage: node scripts/scaffold.mjs <templates-root> <type> <dest> --name=<n> --summary=<s>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

const TEXT_ONLY = /\.(md|txt|json|ya?ml|m?js|cjs|ts|html|css|example)$/i;

function textFiles(dir) {
  return walkFiles(dir)
    .filter(({ isDir, rel }) => {
      if (isDir) return false;
      const name = rel.split('/').pop();
      return name.startsWith('.') || !name.includes('.') || TEXT_ONLY.test(name);
    })
    .map(({ rel }) => rel);
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

export function fillPlaceholders(destDir, values) {
  let count = 0;
  for (const rel of textFiles(destDir)) {
    const path = join(destDir, rel);
    const before = readFileSync(path, 'utf8');
    const after = before.replace(/<([A-Z][A-Z_]{2,})>/g, (match, key) => {
      if (!(key in values)) return match;
      count += 1;
      return values[key];
    });
    if (after !== before) writeFileSync(path, after, 'utf8');
  }
  return count;
}

export function scaffold(templatesRoot, type, destDir, values) {
  const profileDir = join(templatesRoot, 'profiles', type);
  if (!existsSync(profileDir)) throw new Error(`unknown profile type: ${type}`);

  const meta = parseProfileMeta(readFileSync(join(profileDir, 'profile.md'), 'utf8'));
  if (!meta) throw new Error(`profiles/${type}/profile.md has no usable \`\`\`profile block`);

  const base = applyLayer(join(templatesRoot, 'base'), destDir);
  const overlay = applyLayer(profileDir, destDir);
  if (overlay.skipped.length) {
    throw new Error(
      `profile collides with base on: ${overlay.skipped.join(', ')} — ` +
      'move the intended replacements to files-override/',
    );
  }

  injectFragments(destDir, profileDir);
  fillPlaceholders(destDir, {
    YEAR: String(values.year),
    VERIFY_COMMAND: meta.verify,
    TEST_COMMAND: meta.test,
    DEPLOY_COMMAND: meta.deploy,
    ...values.tokens,
  });

  // After substitution, before verification: the digests must describe the repo
  // as it will be committed, and the verifier must see the finished tree.
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

  const provenance = buildProvenance({
    root: destDir,
    version: JSON.parse(readFileSync(join(templatesRoot, 'package.json'), 'utf8')).version,
    profile: type,
    tokens: { YEAR: String(values.year), ...values.tokens },
    files: [...written.values()],
  });
  writeProvenance(destDir, provenance);

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
  const { violations } = scaffold(root, type, dest, {
    year: new Date().getFullYear(),
    tokens: { PROJECT_NAME: flag('name'), PROJECT_SUMMARY: flag('summary') },
  });
  for (const v of violations) console.error(`${v.rule}: ${v.path} — ${v.message}`);
  if (violations.length) {
    console.error(`\nscaffold is incomplete. Inspect ${dest}, then remove it and retry:`);
    console.error(`  Remove-Item -Recurse -Force "${dest}"`);
    return 1;
  }
  console.log(`scaffolded ${flag('name')} (${type}) at ${dest} — clean`);
  return 0;
}

export { main };
runCli(import.meta.url, main);
