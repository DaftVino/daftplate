#!/usr/bin/env node
// PostToolUse(Bash) reminder: after `gh issue create` on a Linear-variant repo,
// tell the session to run /dress.
//
// The dressing step (§6.5.1, ADR 0014) is a skill, and a skill runs only when
// something invokes it. /handoff and standards-change do. A bare
// `gh issue create` — typed freehand, or issued by gstack's /spec, which this repo
// does not own — reaches neither, so without this the issue lands on the board
// undressed. A hook cannot call Linear itself; it can only put one line in front
// of the session, which is all this does. It never blocks, and it fails open.
//
// Installed user-level by install-skills, and only when /dress is installed
// beside it (owner ruling D9), with an `if` filter so the process starts only for
// commands beginning `gh issue create` (D6). The substring check below stays the
// decision anyway: the filter is configuration a user can edit, and a compound
// command such as `cd x && gh issue create` may not match it.
//
// Standalone by construction, like attribution-gate.mjs: no import from this
// repo, because it runs from ~/.claude/. Its Board: read is a fourth copy of one
// parse, held to the others by daftplate's parity test.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Whether a ROADMAP.md's single Board: line declares the Linear variant, and
 *  the short name it gives. Null when it does not. */
export function linearShortName(roadmapText) {
  if (typeof roadmapText !== 'string') return null;
  const lines = roadmapText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('Board:'));
  if (start === -1) return null;
  const paragraph = [];
  for (const line of lines.slice(start)) {
    if (line.trim() === '') break;
    paragraph.push(line);
  }
  const text = paragraph.join(' ');
  if (!/\bLinear\b/.test(text)) return null;
  return /\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(text)?.[1].trim() ?? '';
}

/** The nearest directory at or above `start` holding `.git`, or null. */
export function repoRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Pure decision over one PostToolUse payload plus the roadmap text of the repo it
 * ran in. Returns the reminder text, or null for silence.
 *
 * The payload fields are the documented ones: `tool_name`, `tool_input.command`,
 * and `tool_response.stdout` — Bash's structured output, which carries the issue
 * URL `gh issue create` prints. No field is invented.
 */
/**
 * The command with its heredoc bodies and quoted strings removed, so that only
 * text the shell would run as a command is left to match. Measured live on
 * 2026-10-07: the `if` filter starts this hook for a heredoc whose BODY mentions
 * the phrase, and the first version then reminded about a `gh issue comment`.
 * Not a shell parser, and it does not try to be one: it removes the two places
 * prose about filing an issue actually turns up.
 */
export function executableText(command) {
  const lines = command.split('\n');
  const kept = [];
  let terminator = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/.exec(line);
    if (heredoc) terminator = heredoc[2];
    kept.push(line);
  }
  return kept.join('\n').replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

/** `gh issue create` prints the new issue's URL on a line of its own. Any other
 *  `/issues/N` in the output — a comment's `#issuecomment-…` link, a URL quoted in
 *  prose — is not a filing. */
const FILED_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)\s*$/gm;

export function reminderFor(input, roadmapText) {
  if (input?.tool_name !== 'Bash') return null;
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !/\bgh\s+issue\s+create\b/.test(executableText(command))) return null;
  const short = linearShortName(roadmapText);
  if (short === null) return null;
  const stdout = typeof input?.tool_response?.stdout === 'string' ? input.tool_response.stdout : '';
  // `gh issue create` prints the new issue's URL on success, and only then. No URL
  // means nothing was filed — a failed create, or `--help` — and a reminder about
  // an issue that does not exist is noise the session learns to ignore. Measured
  // live on 2026-10-07: `gh issue create --help` fired the first version.
  const numbers = [...stdout.matchAll(FILED_URL)].map((m) => m[1]);
  if (numbers.length === 0) return null;
  const which = numbers.join(' ');
  const named = short ? ` (${numbers.map((n) => `${short}-${n}`).join(', ')})` : '';
  return `An issue was filed on a Linear-variant repo${named}. The GitHub Issues Sync lands it on the board `
    + `with no project and no priority. Run \`/dress ${which}\` now: it waits for the sync, sets project and `
    + 'priority, and reads them back (repo-standards §6.5.1, ADR 0014).';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input = {};
    // Fail open: a payload this hook cannot read is not an issue that needs dressing.
    try { input = JSON.parse(raw); } catch { /* silence */ }
    // Cheap first: nothing touches the filesystem unless the command could match.
    if (reminderFor(input, 'Board: issues are managed in Linear') === null) process.exit(0);
    const root = repoRoot(typeof input?.cwd === 'string' ? input.cwd : process.cwd());
    const roadmap = root && existsSync(join(root, 'ROADMAP.md')) ? readFileSync(join(root, 'ROADMAP.md'), 'utf8') : null;
    const text = reminderFor(input, roadmap);
    if (text) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
      }));
    }
    process.exit(0);
  });
}
