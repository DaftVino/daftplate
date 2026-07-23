import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHETYPES, buildPrompt, DEFAULT_MODELS, isLooping, nextAction } from '../scripts/deliberate.mjs';

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

test('default models are mid-tier and never max or ultra-high', () => {
  for (const model of Object.values(DEFAULT_MODELS)) {
    assert.match(model, /^(terra|sol)-med$/, `${model} is not a permitted default`);
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
