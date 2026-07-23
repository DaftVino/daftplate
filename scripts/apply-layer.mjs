#!/usr/bin/env node
// Copies a template layer into a destination repo.
//   files/            additive; a collision is skipped (and fatal under --strict)
//   files-override/   declared replacement; always overwrites
//   dot-<name>        → .<name>, files and directories, any depth
//   gitignore-append  → appended to .gitignore rather than copied
// Usage: node scripts/apply-layer.mjs <layer-dir> <dest-dir> [--strict] [--force]
import {
  existsSync, readdirSync, lstatSync, mkdirSync, copyFileSync,
  readFileSync, appendFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { runCli } from './lib/cli.mjs';

const APPEND_FILES = { 'gitignore-append': '.gitignore' };

export function targetName(name) {
  return name.startsWith('dot-') ? `.${name.slice(4)}` : name;
}

function collect(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const source = join(dir, name);
    const rel = prefix ? `${prefix}/${targetName(name)}` : targetName(name);
    return lstatSync(source).isDirectory() ? collect(source, rel) : [{ source, rel, name }];
  });
}

function copyInto(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

export function applyLayer(layerDir, destDir, opts = {}) {
  const filesDir = join(layerDir, 'files');
  const overrideDir = join(layerDir, 'files-override');
  if (!existsSync(filesDir) && !existsSync(overrideDir)) {
    throw new Error(`${layerDir} has no files/ directory`);
  }

  const copied = [];
  const appended = [];
  const overridden = [];
  const skipped = [];

  for (const { source, rel, name } of collect(filesDir)) {
    const appendTarget = APPEND_FILES[name];
    if (appendTarget) {
      const target = join(destDir, appendTarget);
      const addition = readFileSync(source, 'utf8');
      if (existsSync(target)) appendFileSync(target, addition);
      else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, addition); }
      appended.push(appendTarget);
      continue;
    }
    const target = join(destDir, rel);
    if (existsSync(target) && !opts.force) { skipped.push(rel); continue; }
    copyInto(source, target);
    copied.push(rel);
  }

  for (const { source, rel } of collect(overrideDir)) {
    copyInto(source, join(destDir, rel));
    overridden.push(rel);
  }

  return {
    copied: copied.sort(), appended: appended.sort(),
    overridden: overridden.sort(), skipped: skipped.sort(),
  };
}

function main(argv) {
  const args = argv.slice(2);
  const [layer, dest] = args.filter((a) => !a.startsWith('--'));
  if (!layer || !dest) {
    console.error('usage: node scripts/apply-layer.mjs <layer-dir> <dest-dir> [--strict] [--force]');
    return 2;
  }
  const result = applyLayer(layer, dest, { force: args.includes('--force') });
  console.log(
    `copied ${result.copied.length}, appended ${result.appended.length}, ` +
    `overridden ${result.overridden.length}, skipped ${result.skipped.length}`,
  );
  for (const rel of result.skipped) {
    console.error(`collision (base already wrote this): ${rel} — move it to files-override/ if the replacement is intended`);
  }
  return args.includes('--strict') && result.skipped.length ? 1 : 0;
}

export { main };
runCli(import.meta.url, main);
