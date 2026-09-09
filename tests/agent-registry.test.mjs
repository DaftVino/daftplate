import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeRepo } from './helpers/make-repo.mjs';
import {
  AGENTS, QUALIFICATIONS, TRIGGER_KINDS, PRECONDITION_TESTS, UNATTENDED_DRIVERS,
  agentById, agentSkillPresent, validateRegistry, HISTORICAL_NAME_REFERENCES, RETIRED_NAMES,
  NAME_PATTERN_SOURCES,
} from '../scripts/lib/agent-registry.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// What the registry holds
// ---------------------------------------------------------------------------

test('the registry names exactly the two agents that exist', () => {
  assert.deepEqual(AGENTS.map((a) => a.id), ['fixer', 'hunter']);
});

test('agentById finds each entry and refuses an unknown id', () => {
  assert.equal(agentById('fixer').id, 'fixer');
  assert.equal(agentById('hunter').id, 'hunter');
  // Undefined rather than a throw: callers branch on absence, and a menu asked
  // for a row that is not there refuses with its own message rather than a stack.
  assert.equal(agentById('code-map'), undefined);
});

test('every entry names a script that exists on disk', () => {
  for (const agent of AGENTS) {
    assert.ok(existsSync(join(REPO, agent.script)), `${agent.id}: missing ${agent.script}`);
  }
});

test('a skill that has not been written yet is reported, not treated as invalid', () => {
  // Measured against a FIXTURE, not against this checkout.
  //
  // The first version asserted `skills/agent-hunter/` was missing, which was true
  // between Phase 1 and Phase 6 and false the moment Phase 6 wrote it. A test
  // that encodes a temporary state fails when the work it was waiting for lands,
  // and reads as a regression. The durable claim is about the MECHANISM: a
  // missing skill is reported and does not make the registry invalid — the way
  // config-menu.mjs already renders a daftplate skill that exists in the checkout
  // but is not installed.
  const partial = makeRepo({
    'scripts/agent-fixer.mjs': '// stand-in\n',
    'scripts/agent-hunter.mjs': '// stand-in\n',
    'skills/agent-fixer/SKILL.md': '---\nname: agent-fixer\n---\n',
  });
  const missing = AGENTS.filter((a) => !agentSkillPresent(a, partial));
  assert.deepEqual(missing.map((a) => a.id), ['hunter']);
  assert.deepEqual(validateRegistry(AGENTS, { repoRoot: partial }), [],
    'a missing skill must not make the registry invalid');
});

// `this checkout now has every skill its registry names` moved to
// tests/daftplate-checkout.test.mjs: it reads skills/, which the daftplate export
// does not ship, so it arrived red in a stranger's clone.

test('a script that does not exist IS invalid, because the entry names nothing runnable', () => {
  const violations = validateRegistry([{ ...AGENTS[0], script: 'scripts/agent-ghost.mjs' }], { repoRoot: REPO });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'agent-missing-script');
});

test('the registry and its entries are frozen', () => {
  assert.ok(Object.isFrozen(AGENTS));
  for (const agent of AGENTS) assert.ok(Object.isFrozen(agent), `${agent.id} is not frozen`);
});

test('naming is derived from the id, not spelled twice', () => {
  // D7: the registry id is the one true name. An entry whose script or skill
  // does not follow from its id is a second name for the same thing, which is
  // the failure the naming convention exists to prevent.
  for (const agent of AGENTS) {
    assert.equal(agent.script, `scripts/agent-${agent.id}.mjs`);
    assert.equal(agent.skill, `skills/agent-${agent.id}/`);
  }
});

// ---------------------------------------------------------------------------
// The gate — D1, and the mutation that must not survive it
// ---------------------------------------------------------------------------

test('every entry declares at least one qualification, from the known three', () => {
  for (const agent of AGENTS) {
    assert.ok(agent.qualifies.length >= 1, `${agent.id} declares no qualification`);
    for (const q of agent.qualifies) {
      assert.ok(QUALIFICATIONS.includes(q), `${agent.id}: "${q}" is not a qualification`);
    }
  }
});

test('validateRegistry refuses an entry with no qualification', () => {
  // M1. This is D1's gate made real rather than advisory: `node
  // scripts/code-map.mjs .` runs on a cadence and would look at home in a list
  // of agents, and giving it a claim ledger and a worktree makes it worse.
  // The script is a real one, so the ONLY thing wrong with this entry is that it
  // qualifies for nothing. A fixture pointing at a script that does not exist
  // would raise a second violation and let a no-opped gate pass on the other one.
  const violations = validateRegistry([{
    id: 'code-map',
    script: 'scripts/code-map.mjs',
    skill: 'skills/agent-code-map/',
    summary: 'refresh the symbol index',
    qualifies: [],
    trigger: { kind: 'schedule', preconditions: [] },
    // Declared for the same reason the script path is a real one: the fixture must
    // be wrong in exactly one way, or a no-opped qualification gate would pass on
    // somebody else's violation.
    unattended: { args: ['--scheduled'], driver: 'gated' },
    gate: null,
    defaultWindow: null,
  }], { repoRoot: REPO });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'agent-unqualified');
  assert.match(violations[0].message, /judgement|work-product|state/);
});

test('validateRegistry refuses an entry that declares no unattended argv', () => {
  // `#223 (FORGE-294)`. The sweeper composes what it spawns from this field, so an
  // entry without it composes `undefined` into an argv — and `stdio: 'ignore'`
  // means nobody ever sees what that launched.
  const { unattended, ...without } = AGENTS[0];
  const violations = validateRegistry([without], { repoRoot: REPO });
  assert.ok(violations.some((v) => v.rule === 'agent-no-unattended-args'),
    `got: ${JSON.stringify(violations)}`);
});

test('validateRegistry refuses an unattended driver outside the known set', () => {
  // An unknown driver is worse than a missing one, because every `=== 'none'`
  // test reads it as startable and every `!== 'none'` test reads it as startable
  // too — so it is never refused and never started, which is silence.
  for (const driver of ['later', null, undefined, 'None']) {
    const violations = validateRegistry([{
      ...AGENTS[0],
      unattended: { args: ['--scheduled'], driver },
    }], { repoRoot: REPO });
    assert.ok(violations.some((v) => v.rule === 'agent-unknown-unattended-driver'),
      `driver ${JSON.stringify(driver)} was accepted`);
  }
});

test('every shipped entry declares an unattended argv and a known driver', () => {
  for (const agent of AGENTS) {
    assert.ok(Array.isArray(agent.unattended.args), `${agent.id}: no unattended.args`);
    assert.ok(UNATTENDED_DRIVERS.includes(agent.unattended.driver), `${agent.id}: unknown driver`);
    // ADR 0008 row 1, at the one place a scheduled argv is now declared.
    const flat = agent.unattended.args.join(' ');
    for (const forbidden of ['dangerously-skip-permissions', 'bypassPermissions']) {
      assert.ok(!flat.includes(forbidden), `${agent.id} declares ${forbidden}`);
    }
  }
});

test('validateRegistry refuses a qualification it does not know', () => {
  const violations = validateRegistry([{
    id: 'fixer',
    script: 'scripts/agent-fixer.mjs',
    skill: 'skills/agent-fixer/',
    summary: 'x',
    qualifies: ['useful'],
    trigger: { kind: 'schedule', preconditions: [] },
    gate: null,
    defaultWindow: null,
  }], { repoRoot: REPO });
  assert.ok(violations.some((v) => v.rule === 'agent-unqualified'));
});

test('validateRegistry reports a non-array qualifies rather than throwing', () => {
  // A `qualifies` that is present and truthy but not an array (a string, an
  // object) is not caught by `agent.qualifies?.filter(...) ?? []` — that guard
  // only substitutes for a nullish value, and `.filter` on a string or a plain
  // object is `undefined`, so calling it throws. This function's own doc comment
  // promises "violations rather than a throw" for every way an entry can be
  // wrong; a malformed `qualifies` is one of those ways.
  for (const badQualifies of ['judgement', { judgement: true }]) {
    const violations = validateRegistry([{ ...AGENTS[0], qualifies: badQualifies }], { repoRoot: REPO });
    assert.ok(violations.some((v) => v.rule === 'agent-unqualified'),
      `qualifies=${JSON.stringify(badQualifies)} did not produce agent-unqualified`);
  }
});

test('validateRegistry treats a missing qualifies the same as an empty one', () => {
  for (const missing of [null, undefined]) {
    const violations = validateRegistry([{ ...AGENTS[0], qualifies: missing }], { repoRoot: REPO });
    assert.ok(violations.some((v) => v.rule === 'agent-unqualified'));
  }
});

test('validateRegistry reports a non-array preconditions rather than throwing', () => {
  // Same failure shape as `qualifies`: `agent.trigger?.preconditions ?? []` does
  // nothing for a truthy non-array value, and `for...of` on a plain object throws
  // "is not iterable" instead of this function returning a violation.
  const violations = validateRegistry([{
    ...AGENTS[0],
    trigger: { kind: 'schedule', preconditions: { id: 'x' } },
  }], { repoRoot: REPO });
  assert.ok(violations.some((v) => v.rule === 'agent-invalid-preconditions'),
    `got: ${JSON.stringify(violations)}`);
});

test('validateRegistry treats a missing preconditions the same as an empty array', () => {
  for (const missing of [null, undefined]) {
    const violations = validateRegistry([{
      ...AGENTS[0],
      trigger: { kind: 'schedule', preconditions: missing },
    }], { repoRoot: REPO });
    assert.deepEqual(violations, []);
  }
});

test('board-variant-pollable reports no board rather than throwing on a nullish context', () => {
  // Phase 1's evaluator destructured `{ board } = {}`, which only substitutes for
  // an `undefined` argument — `evaluate(null)` still throws trying to destructure
  // `null`. `inspect()` in agent-menu.mjs always calls with a real object, so this
  // was latent rather than live, but the table is exported and callable directly.
  for (const ctx of [undefined, null, {}, { board: null }, { board: undefined }]) {
    const result = PRECONDITION_TESTS['board-variant-pollable'](ctx);
    assert.equal(result.met, false, `ctx=${JSON.stringify(ctx)}`);
    assert.match(result.detail, /no board/);
  }
});

test('validateRegistry refuses two entries sharing an id', () => {
  const one = AGENTS[0];
  const violations = validateRegistry([one, one], { repoRoot: REPO });
  assert.ok(violations.some((v) => v.rule === 'agent-duplicate-id'));
});

test('the real registry passes its own validator', () => {
  assert.deepEqual(validateRegistry(AGENTS, { repoRoot: REPO }), []);
});

// ---------------------------------------------------------------------------
// Triggers and preconditions — data with a named test, never a closure
// ---------------------------------------------------------------------------

test('every trigger names a known kind', () => {
  for (const agent of AGENTS) {
    assert.ok(TRIGGER_KINDS.includes(agent.trigger.kind), `${agent.id}: ${agent.trigger.kind}`);
  }
});

test('every precondition names an evaluator that exists', () => {
  for (const agent of AGENTS) {
    for (const pre of agent.trigger.preconditions) {
      assert.ok(pre.test in PRECONDITION_TESTS, `${agent.id}: no evaluator "${pre.test}"`);
    }
  }
});

test('a precondition carries no function, so a registry entry cannot change the menu', () => {
  // An entry able to carry arbitrary code would let a registry addition alter
  // behaviour without touching the menu, which is the reviewability the curated
  // list was chosen for in the first place (D5).
  for (const agent of AGENTS) {
    for (const pre of agent.trigger.preconditions) {
      for (const [key, value] of Object.entries(pre)) {
        assert.notEqual(typeof value, 'function', `${agent.id}: ${key} is a function`);
      }
    }
  }
});

test('validateRegistry refuses a precondition naming no evaluator', () => {
  const violations = validateRegistry([{
    ...AGENTS[0],
    trigger: { kind: 'board-poll', preconditions: [{ id: 'x', test: 'no-such-evaluator', unmetMessage: 'm', ownerAct: 'a' }] },
  }], { repoRoot: REPO });
  assert.ok(violations.some((v) => v.rule === 'agent-unknown-precondition'));
});

test('every unmet precondition names an owner act, because a refusal without one strands the reader', () => {
  for (const agent of AGENTS) {
    for (const pre of agent.trigger.preconditions) {
      assert.ok(pre.unmetMessage?.length > 10, `${agent.id}/${pre.id}: no unmetMessage`);
      assert.ok(pre.ownerAct?.length > 10, `${agent.id}/${pre.id}: no ownerAct`);
    }
  }
});

test('the fixer gates on a board being declared, and names an act that would close it', () => {
  // Renamed from `linear-delegated-state` on 2026-09-04. That precondition asserted
  // the board variant was not `linear`, which no owner act could ever change: its
  // own `ownerAct` told them to create a `Delegated` workflow state, and the
  // evaluator never looked at Linear at all. An instruction that cannot close the
  // thing it is attached to is worse than none, because it is followed.
  //
  // A label applied in Linear reaches the GitHub issue through the issues sync, so
  // both variants poll one path and the only remaining question is whether a board
  // was declared at all.
  const fixer = agentById('fixer');
  const pre = fixer.trigger.preconditions.find((p) => p.id === 'board-declared');
  assert.ok(pre, 'the fixer has no board-declared precondition');
  assert.match(pre.ownerAct, /agent:delegated/);
  // The retired id must not survive anywhere in the registry: a screen keyed on it
  // would silently stop finding the row it renders.
  assert.equal(
    AGENTS.some((a) => a.trigger.preconditions.some((p) => p.id === 'linear-delegated-state')),
    false,
    'the retired precondition id is still declared',
  );
});

// ---------------------------------------------------------------------------
// The renames — live references gone, historical ones deliberately kept
// ---------------------------------------------------------------------------

const gitGrep = (pattern) => {
  try {
    return execFileSync('git', ['grep', '-l', '-E', pattern], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (err) {
    // git grep exits 1 on no match, which is the clean case, not a failure.
    if (err.status === 1) return [];
    throw err;
  }
};

test('no live file references a retired name', () => {
  const hits = gitGrep(RETIRED_NAMES.join('|'));
  const live = hits.filter((path) => !(path in HISTORICAL_NAME_REFERENCES)
    && !NAME_PATTERN_SOURCES.includes(path));
  assert.deepEqual(live, [], `these still name a retired script or skill: ${live.join(', ')}`);
});

test('the pattern definition site is exempt, and is exempt for its own reason', () => {
  // It matches because it holds the patterns. This was latent for exactly one
  // commit: `git grep` skips untracked files, so the sweep passed while
  // agent-registry.mjs was uncommitted and failed on the next run.
  assert.ok(NAME_PATTERN_SOURCES.includes('scripts/lib/agent-registry.mjs'));
  // Kept out of the historical map, which is about records that must not be
  // rewritten. One list meaning two things is how both stop being read.
  for (const path of NAME_PATTERN_SOURCES) {
    assert.ok(!(path in HISTORICAL_NAME_REFERENCES), `${path} is in both exemption lists`);
  }
});

test('every historical exemption present in this checkout really does reference a retired name', () => {
  // Otherwise the list rots into a set of permissions nobody needs, and the next
  // reader takes it as evidence the names are still in use.
  //
  // **Filtered to files this checkout actually has, and the filter is load-bearing
  // rather than defensive.** Measured: the daftplate export ships this test file
  // and `CHANGELOG.md`, and withholds the other five exemptions — every
  // `docs/designs/` and `docs/records/` path, of which it ships none. An
  // unfiltered assertion would pass here and fail in the exported suite, which is
  // the failure `/publish` running that suite exists to catch.
  const hits = new Set(gitGrep(RETIRED_NAMES.join('|')));
  const present = Object.keys(HISTORICAL_NAME_REFERENCES)
    .filter((path) => existsSync(join(REPO, path)));

  // A filter that silently reduced to nothing would make this test decorative in
  // exactly the repository where it still matters, so the floor is asserted.
  assert.ok(present.length >= 1, 'no exemption file is present, so this test checked nothing');

  for (const path of present) {
    assert.ok(hits.has(path), `${path} is exempted but no longer references a retired name`);
  }
});

test('every historical exemption gives a reason that is not a restatement of its path', () => {
  // The export denylist's reason fields exist because a bare entry under a prose
  // comment reads as something nobody got round to deleting. Same failure here.
  for (const [path, reason] of Object.entries(HISTORICAL_NAME_REFERENCES)) {
    assert.ok(reason.length >= 40, `${path}: reason is too short to be one`);
    assert.ok(!reason.includes(path), `${path}: the reason restates the path`);
  }
});

test('the changelog and the hunt record are exempt, because editing them would falsify a record', () => {
  // Named individually rather than covered by a directory rule: these two are the
  // reason the blanket "no file references the old names" criterion was wrong.
  assert.ok('CHANGELOG.md' in HISTORICAL_NAME_REFERENCES);
  assert.ok('docs/records/hunt/2026-08-27-phase-1.md' in HISTORICAL_NAME_REFERENCES);
});

test('CHANGELOG.md is the exemption the export ships, so it is the one that must hold there', () => {
  // The export withholds every docs/designs and docs/records path. If a later
  // change moved the changelog's retired names out, the previous test's floor
  // would drop to zero in the exported suite and it would pass by checking
  // nothing. Pinning the one shipped exemption is what stops that.
  assert.ok(gitGrep(RETIRED_NAMES.join('|')).includes('CHANGELOG.md'));
});
