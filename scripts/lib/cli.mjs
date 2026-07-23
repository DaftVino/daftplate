// Shared plumbing: every script here is an importable module and a command.
import { pathToFileURL } from 'node:url';

export const violation = (rule, path, message) => ({ rule, path, message });

export function reportViolations(violations) {
  for (const v of violations) console.error(`${v.rule}: ${v.path} — ${v.message}`);
  console.log(violations.length ? `${violations.length} violation(s)` : 'clean');
  return violations.length ? 1 : 0;
}

export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && importMetaUrl === pathToFileURL(process.argv[1]).href;
}

export function runCli(importMetaUrl, main) {
  if (isMain(importMetaUrl)) process.exit(main(process.argv));
}
