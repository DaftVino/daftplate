// Extracted from tests/verify-templates.test.mjs when a second suite needed it.
// It was a module-private function there, so a new test file could not import it
// and would have had to duplicate a parser this repo has already mutation-tested.
/** One `updates:` item, as raw lines. No YAML parser is available (CLAUDE.md #4),
 *  so this walks indentation: an item starts at `- package-ecosystem: <x>` and
 *  runs until the next line indented no deeper than that `-`.
 *
 *  Scoping to the item is the whole point, and three independent regexes over the
 *  file would not do it. This config passes "contains github-actions" AND
 *  "contains interval: weekly" while performing no action updates whatsoever:
 *
 *      updates:
 *        - package-ecosystem: github-actions
 *          directory: /
 *        - package-ecosystem: npm
 *          directory: /
 *          schedule:
 *            interval: weekly
 *
 *  Comments are stripped first so prose about the ecosystem cannot stand in for
 *  a declaration of it. */
export function dependabotEntry(text, ecosystem) {
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
  const opener = new RegExp(`^(\\s*)-\\s+package-ecosystem:\\s*['"]?${ecosystem}['"]?\\s*$`);
  const start = lines.findIndex((line) => opener.test(line));
  if (start === -1) return null;

  const column = lines[start].match(/^\s*/)[0].length;
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (lines[i].match(/^\s*/)[0].length <= column) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}
