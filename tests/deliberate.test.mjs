import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHETYPES, buildPrompt, buildTargetedPrompt, DEFAULT_MODELS, isLooping, nextAction } from '../scripts/deliberate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A panel costs six figures of tokens. The step that makes it reusable is the
// record, and a step that lives only in prose is a step that gets skipped — so
// the skill is held to naming the destination and the falsifier discipline.
test('the deliberate SKILL.md requires the panel to be recorded', () => {
  const skill = readFileSync(join(ROOT, 'skills', 'deliberate', 'SKILL.md'), 'utf8');
  assert.match(skill, /docs\/panels\/YYYY-MM-DD-slug\.md/, 'the record has no named destination');
  assert.match(skill, /falsifiers, not opinions/i, 'revisit triggers must be framed as falsifiers');
  assert.match(skill, /## 8\./, 'the record step must be a numbered step, not an aside');
});

// Every record carries the triggers table; without it the file is a transcript,
// not something a later session can act on.
test('every panel record states its revisit triggers', () => {
  const dir = join(ROOT, 'docs', 'panels');
  const records = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(records.length > 0, 'docs/panels exists but holds no record');

  for (const name of records) {
    const text = readFileSync(join(dir, name), 'utf8');
    assert.match(text, /^## Revisit triggers$/m, `${name}: no revisit triggers section`);
    assert.match(text, /^## What moved/m, `${name}: does not record what moved`);
  }
});

test('there are exactly three archetypes, each with a distinct stance', () => {
  assert.equal(ARCHETYPES.length, 3);
  assert.deepEqual(ARCHETYPES.map((a) => a.id).sort(), ['aesthete', 'native', 'veteran']);
  assert.equal(new Set(ARCHETYPES.map((a) => a.stance)).size, 3);
});

test('every archetype prompt states its stance and instructs it to hold that line', () => {
  for (const a of ARCHETYPES) {
    assert.match(a.prompt, /hold your position/i, `${a.id} is not told to argue`);
    assert.ok(a.prompt.length > 200, `${a.id} prompt is too thin to produce a real stance`);
  }
});

test('buildPrompt embeds the topic and the round context', () => {
  const p = buildPrompt(ARCHETYPES[0], { topic: 'Should we drop the code map?', round: 2, others: ['veteran said X'] });

  assert.match(p, /Should we drop the code map\?/);
  assert.match(p, /round 2/i);
  assert.match(p, /veteran said X/);
});

test('round 1 prompts carry no peer arguments', () => {
  const p = buildPrompt(ARCHETYPES[0], { topic: 'T', round: 1, others: [] });
  assert.equal(p.includes('what the others argued'), false);
});

test('a targeted round carries the disputes and forbids a re-file', () => {
  const p = buildTargetedPrompt(ARCHETYPES[1], {
    topic: 'Should we drop the code map?',
    round: 2,
    disputes: ['whether the map earns its refresh cost', 'who owns staleness'],
    others: ['native said X'],
  });

  assert.match(p, /1\. whether the map earns its refresh cost/);
  assert.match(p, /2\. who owns staleness/);
  assert.match(p, /do NOT re-file/i);
  assert.match(p, /change one of your conclusions or cite new/i);
  assert.match(p, /native said X/);
});

test('a targeted round works with no peer arguments supplied', () => {
  const p = buildTargetedPrompt(ARCHETYPES[0], { topic: 'T', round: 2, disputes: ['d'] });
  assert.equal(p.includes('what the others argued'), false);
});

test('default models are real codex ids at medium effort, never max or ultra-high', () => {
  for (const { model, effort } of Object.values(DEFAULT_MODELS)) {
    assert.match(model, /^gpt-[\d.]+-(terra|sol)$/, `${model} is not a permitted default`);
    assert.equal(effort, 'medium');
  }
});

const round = (n, a, v, ae) => ({ n, positions: { native: a, veteran: v, aesthete: ae } });

test('isLooping is false on a single round', () => {
  assert.equal(isLooping([round(1, 'x', 'y', 'z')]), false);
});

test('isLooping is true when nobody moved between two rounds', () => {
  assert.equal(isLooping([round(1, 'x', 'y', 'z'), round(2, 'x', 'y', 'z')]), true);
});

test('isLooping is false when at least one archetype moved', () => {
  assert.equal(isLooping([round(1, 'x', 'y', 'z'), round(2, 'x', 'y', 'MOVED')]), false);
});

test('nextAction halts on a loop rather than paying for another round', () => {
  const r = nextAction([round(1, 'x', 'y', 'z'), round(2, 'x', 'y', 'z')], { maxRounds: 3 });
  assert.equal(r.action, 'halt');
  assert.match(r.reason, /loop|repeat/i);
});

test('nextAction resolves at maxRounds even if they are still arguing', () => {
  const r = nextAction([round(1, 'a', 'b', 'c'), round(2, 'd', 'e', 'f'), round(3, 'g', 'h', 'i')], { maxRounds: 3 });
  assert.equal(r.action, 'resolve');
});

test('nextAction continues while positions are still moving and rounds remain', () => {
  const r = nextAction([round(1, 'a', 'b', 'c'), round(2, 'd', 'e', 'f')], { maxRounds: 3 });
  assert.equal(r.action, 'continue');
});
