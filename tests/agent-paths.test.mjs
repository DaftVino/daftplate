// Phase 2 of `#204 (FORGE-265)`: run ids name their agent, and every run-scoped
// path family sits under a per-agent subdirectory.
//
// The load-bearing test in this file is the claim collision. `claimPath` keyed on
// the issue number alone, so the hunter reading `#193` took the claim the fixer
// was holding — a structural collision, not a hypothetical, and the reason the
// subdirectory exists at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDir } from './helpers/make-repo.mjs';
import {
  runsRoot, agentRoot, worktreePath, containedIn, MISSING_AGENT,
} from '../scripts/lib/worktree.mjs';
import {
  recordsDir, recordPath, stopsDir, stopPath, settingsPath,
  RECORD_KIND, STOP_KIND, listRunRecords, openRunRecord,
} from '../scripts/lib/run-record.mjs';
import {
  newRunId, claimsDir, claimPath, claimIssue, readClaim, CLAIM_KIND,
} from '../scripts/agent-fixer.mjs';
import { reproductionPath, bodyPath } from '../scripts/lib/publish-run.mjs';
import { isolationPaths } from '../scripts/lib/agent-invoke.mjs';

const REPO = 'X:/some/repo';
const at = new Date('2026-08-28T20:00:00.000Z');

// ---------------------------------------------------------------------------
// Run ids name their agent
// ---------------------------------------------------------------------------

test('a run id leads with the agent that produced it', () => {
  assert.match(newRunId('fixer', 193, at), /^fixer-193-\d{8}T\d{6}Z$/);
  assert.match(newRunId('hunter', 193, at), /^hunter-193-\d{8}T\d{6}Z$/);
});

test('two agents on one issue at the same instant produce different run ids', () => {
  // The old form was `run-<issue>-<timestamp>`, which is the same string for
  // both — so `--list` showed two runs it could not tell apart, and the second
  // record written silently replaced the first.
  assert.notEqual(newRunId('fixer', 193, at), newRunId('hunter', 193, at));
});

test('newRunId refuses to build an id with no agent', () => {
  // A run id is the key every path family is derived from. One built without an
  // agent reintroduces exactly the collision this phase removes, so it fails
  // loudly rather than producing `undefined-193-…`.
  assert.throws(() => newRunId(undefined, 193, at), /agent/i);
  assert.throws(() => newRunId('', 193, at), /agent/i);
});

test('newRunId refuses an agent the registry does not name', () => {
  // A falsy-only guard is not enough, measured rather than supposed: five call
  // sites survived the Phase 2 rename still calling `newRunId(5)` — the old
  // single-argument form, with the ISSUE number landing in the agent position.
  // `5` is truthy, so the guard waved it through and produced
  // `5-undefined-<timestamp>`: an id naming an agent that does not exist, for an
  // issue that is not a number. Nothing caught it, because those call sites also
  // passed an explicit runId override and the malformed value was discarded.
  assert.throws(() => newRunId(5, undefined, at), /not one of/);
  assert.throws(() => newRunId('ghost', 193, at), /not one of/);
  // And the issue has to be one. `fixer-undefined-…` is no better than
  // `5-undefined-…`; both key a whole directory tree off a typo.
  assert.throws(() => newRunId('fixer', undefined, at), /issue/i);
  assert.throws(() => newRunId('fixer', '193', at), /issue/i);
});

// ---------------------------------------------------------------------------
// Every run-scoped path sits under the agent
// ---------------------------------------------------------------------------

const io = { agent: 'fixer', runsDir: 'X:/runs' };

test('agentRoot is the runs root plus the agent, and nothing else', () => {
  assert.equal(agentRoot(REPO, io), join(runsRoot(REPO, io), 'fixer'));
});

test('all eight run-scoped families sit under the agent root', () => {
  // Five are the spec's table. `reproductions/`, `bodies/` and `isolation/` are
  // three more with the same shape that the table missed; they are moved too, so
  // a human browsing the runs root can tell which agent produced a reproduction
  // without parsing a run id to find out.
  const root = agentRoot(REPO, io);
  const runId = newRunId('fixer', 193, at);
  const under = [
    worktreePath(REPO, runId, io),
    claimsDir(REPO, io),
    claimPath(REPO, 193, io),
    recordsDir(REPO, io),
    recordPath(REPO, runId, io),
    stopsDir(REPO, io),
    stopPath(REPO, runId, io),
    settingsPath(REPO, runId, io),
    reproductionPath(REPO, runId, io),
    bodyPath(REPO, runId, 'pr', io),
    isolationPaths(REPO, runId, io).dir,
  ];
  for (const path of under) {
    assert.ok(path.startsWith(root), `${path} is not under ${root}`);
  }
});

test('a path built without an agent throws rather than falling back to the flat layout', () => {
  // The dangerous failure is silent: a caller that forgets the agent writing to
  // `runs/<key>/claims/193.json`, which is the pre-Phase-2 path both agents
  // shared. Refusing beats defaulting, because the default is the bug.
  for (const build of [
    () => agentRoot(REPO, { runsDir: 'X:/runs' }),
    () => claimPath(REPO, 193, { runsDir: 'X:/runs' }),
    () => recordsDir(REPO, { runsDir: 'X:/runs' }),
    () => settingsPath(REPO, 'fixer-193-x', { runsDir: 'X:/runs' }),
  ]) {
    assert.throws(build, new RegExp(MISSING_AGENT.slice(0, 20)));
  }
});

test('a run id whose agent disagrees with the one asked for is refused', () => {
  // Writing the fixer's record into the hunter's directory is the collision from
  // the other side, and it is the one a caller makes by threading the wrong opts.
  assert.throws(
    () => recordPath(REPO, 'hunter-193-20260828T200000Z', { agent: 'fixer', runsDir: 'X:/runs' }),
    /hunter.*fixer|fixer.*hunter/,
  );
});

test('a run id that names no agent contradicts nothing and is allowed', () => {
  // The check catches DISAGREEMENT, not a naming scheme. An id like `run-iso` or
  // a caller's own opaque string names no agent, so there is nothing for it to
  // disagree with — and refusing it would make the guard an enforcement of
  // convention rather than a guard against the one bug it exists for.
  assert.doesNotThrow(() => recordPath(REPO, 'run-iso', { agent: 'fixer', runsDir: 'X:/runs' }));
  assert.doesNotThrow(() => recordPath(REPO, 'anything', { agent: 'hunter', runsDir: 'X:/runs' }));
  assert.ok(recordPath(REPO, 'run-iso', { agent: 'fixer', runsDir: 'X:/runs' })
    .startsWith(agentRoot(REPO, { agent: 'fixer', runsDir: 'X:/runs' })));
});

// ---------------------------------------------------------------------------
// Containment, family by family — `#215 (FORGE-275)`
// ---------------------------------------------------------------------------

// The four spellings of the payload. The second and fourth are the native ones on
// the workstation these agents run on, and they are the reason this table exists:
// `#215 (FORGE-275)` is two containment guards that refused the forward-slash
// traversal and accepted the backslash one, and a table written in one separator
// would have agreed with the bug.
const TRAVERSING = [
  'fixer-' + '../'.repeat(3) + 'evil',
  String.raw`fixer-..\..\evil`,
  'fixer-a/b',
  String.raw`fixer-C:\x`,
];

// Ids that traverse nowhere and must keep working. `run-iso` names no agent at
// all, which is the case `assertRunIdAgent` was deliberately narrowed to allow —
// a containment guard that grew into naming-convention enforcement would break
// every fixture in the suite and read as if it were doing its job.
const BENIGN = ['fixer-1-20260829T0000Z', 'run-iso'];

// Seven of the eight families are keyed on a run id. Each is named as its caller
// writes it, so a family that grew a new argument shows up here as a compile-time
// shape change rather than as a silently skipped row.
const RUN_ID_FAMILIES = [
  ['worktreePath', (id) => [worktreePath(REPO, id, io)]],
  ['recordPath', (id) => [recordPath(REPO, id, io)]],
  ['stopPath', (id) => [stopPath(REPO, id, io)]],
  ['settingsPath', (id) => [settingsPath(REPO, id, io)]],
  ['reproductionPath', (id) => [reproductionPath(REPO, id, io)]],
  ['bodyPath', (id) => [bodyPath(REPO, id, 'pr', io)]],
  // All four, not just `dir`. The three leaves are where the isolated git and gh
  // configuration is written, so a contained `dir` with an escaping leaf would be
  // containment that holds only for the value nobody uses.
  ['isolationPaths', (id) => Object.values(isolationPaths(REPO, id, io))],
];

test('every run-id path family refuses a traversing run id, in either separator', () => {
  // The guarantee is per family, not per guard. `assertRunIdAgent` is the one
  // place all seven pass through today, and that is exactly the claim worth
  // pinning: a family added later that joins a run id without calling it, or a
  // widening of `RUN_ID_CHARSET` to admit `.` or a separator, breaks this table
  // rather than passing quietly.
  //
  // Mutation killed: widening `RUN_ID_CHARSET` in `scripts/lib/worktree.mjs` to
  // `^[A-Za-z0-9][A-Za-z0-9-./\\:]*$`. Measured — all 28 rows go red.
  for (const [name, build] of RUN_ID_FAMILIES) {
    for (const id of TRAVERSING) {
      assert.throws(() => build(id), /run id/,
        `${name} accepted the traversing run id \`${id}\``);
    }
  }
});

test('every run-id path family resolves a benign id INSIDE the agent root', () => {
  // Asserted on the resolved path rather than on the guard having been called —
  // `#215 (FORGE-275)` acceptance criterion 3. A test that only checked the guard
  // ran would still pass for a family that called it and then joined a different
  // string.
  //
  // Mutation killed: narrowing `RUN_ID_CHARSET` to the lowercase-only
  // `^[a-z0-9-]+$` a first draft proposed, which refuses every id `newRunId`
  // mints (uppercase `T`, trailing `Z`).
  const root = agentRoot(REPO, io);
  for (const [name, build] of RUN_ID_FAMILIES) {
    for (const id of BENIGN) {
      let paths;
      assert.doesNotThrow(() => { paths = build(id); }, `${name} refused the benign run id \`${id}\``);
      for (const path of paths) {
        assert.ok(containedIn(root, path), `${name}(\`${id}\`) resolved to ${path}, outside ${root}`);
      }
    }
  }
});

test('the eighth family is keyed on the issue, and refuses one that is not a number', () => {
  // `claims/` is the one run-scoped family whose key is not a run id, so
  // `assertRunIdAgent` never sees it and the traversal table above cannot cover
  // it. Measured before the fix: `claimPath(REPO, '../../evil', io)` resolved to
  // `…/runs/<key>/evil.json` — two levels above the agent root — and the
  // backslash spelling resolved to the same place.
  //
  // Unreachable today (`--issue` is parsed with `/^[1-9][0-9]*$/`, and `runIssue`
  // takes `issue.number` off the `gh` JSON), which is containment holding by the
  // good manners of every caller rather than by a check — the same thing
  // `assertRunIdAgent` was found doing in this issue.
  //
  // Mutation killed: disabling the `Number.isInteger` guard in `claimPath`
  // (`scripts/agent-fixer.mjs`). The `'193'` row is what makes the class rather
  // than a traversal regex the assertion — a string of digits traverses nowhere
  // and is still not the key this ledger is addressed by.
  const root = agentRoot(REPO, io);
  for (const issue of ['../../evil', String.raw`..\..\evil`, '193', 1.5, null, undefined]) {
    assert.throws(() => claimPath(REPO, issue, io), /issue number/,
      `claimPath accepted the issue key \`${String(issue)}\``);
  }
  assert.ok(containedIn(root, claimPath(REPO, 193, io)));
});

test('the three directory families take no run id, so no run id can move them', () => {
  // Named in the eight for completeness of the table above: `claims/`, `records/`
  // and `stops/` are the containers, addressed by the agent alone. Their
  // containment is not a guard's doing and cannot be undone by a hostile id,
  // because there is no id in them to be hostile.
  const root = agentRoot(REPO, io);
  for (const [name, path, leaf] of [
    ['claimsDir', claimsDir(REPO, io), 'claims'],
    ['recordsDir', recordsDir(REPO, io), 'records'],
    ['stopsDir', stopsDir(REPO, io), 'stops'],
  ]) {
    assert.ok(containedIn(root, path), `${name} resolved to ${path}, outside ${root}`);
    assert.equal(path, join(root, leaf));
  }
});

// ---------------------------------------------------------------------------
// The collision this phase exists to remove
// ---------------------------------------------------------------------------

test('the fixer and the hunter both claim one issue, and neither sees the other', () => {
  const runs = emptyDir();
  const fixer = { agent: 'fixer', runsDir: runs };
  const hunter = { agent: 'hunter', runsDir: runs };

  const a = claimIssue({ repoRoot: REPO, issue: 193, runId: newRunId('fixer', 193, at) }, fixer);
  const b = claimIssue({ repoRoot: REPO, issue: 193, runId: newRunId('hunter', 193, at) }, hunter);

  assert.equal(a.ok, true, 'the fixer could not claim #193');
  assert.equal(b.ok, true, `the hunter was blocked by the fixer's claim: ${b.reason}`);
  assert.notEqual(a.path, b.path);

  assert.equal(readClaim(REPO, 193, fixer).runId, a.claim.runId);
  assert.equal(readClaim(REPO, 193, hunter).runId, b.claim.runId);
});

test('one agent still cannot claim an issue it has already claimed', () => {
  // The exclusion must survive the split: per-agent directories separate the two
  // agents, they do not weaken the ledger within one.
  const runs = emptyDir();
  const fixer = { agent: 'fixer', runsDir: runs };
  const first = claimIssue({ repoRoot: REPO, issue: 77, runId: newRunId('fixer', 77, at) }, fixer);
  const second = claimIssue({ repoRoot: REPO, issue: 77, runId: newRunId('fixer', 77, new Date()) }, fixer);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-claimed');
});

// ---------------------------------------------------------------------------
// Discovery sweeps every agent — ADR 0008 row 8
// ---------------------------------------------------------------------------

test('listRunRecords finds runs of every agent from one call', () => {
  // Row 8: discoverable without reading a transcript. A human told an agent is
  // loose should not have to know WHICH agent in order to find it, so listing
  // takes no agent and sweeps them all.
  const runs = emptyDir();
  openRunRecord({
    repoRoot: REPO, runId: newRunId('fixer', 1, at), issue: { number: 1 }, authority: {},
  }, { agent: 'fixer', runsDir: runs });
  openRunRecord({
    repoRoot: REPO, runId: newRunId('hunter', 2, at), issue: { number: 2 }, authority: {},
  }, { agent: 'hunter', runsDir: runs });

  const found = listRunRecords(REPO, { runsDir: runs });
  assert.deepEqual(found.map((r) => r.agent).sort(), ['fixer', 'hunter']);
});

test('a listing reports which agent each run belongs to', () => {
  const runs = emptyDir();
  const runId = newRunId('hunter', 9, at);
  openRunRecord({ repoRoot: REPO, runId, issue: { number: 9 }, authority: {} }, { agent: 'hunter', runsDir: runs });
  const [found] = listRunRecords(REPO, { runsDir: runs });
  assert.equal(found.agent, 'hunter');
  assert.equal(found.runId, runId);
});

test('a stray directory under the runs root is not read as an agent', () => {
  // The runs root is a directory on a real machine and things end up in it. A
  // sweep that treated every subdirectory as an agent would report a half-written
  // temp directory as a run nobody can stop.
  const runs = emptyDir();
  mkdirSync(join(runs, 'not-an-agent', 'records'), { recursive: true });
  writeFileSync(join(runs, 'not-an-agent', 'records', 'x.json'), '{"kind":"nope"}\n');
  assert.deepEqual(listRunRecords(REPO, { runsDir: runs }), []);
});

// ---------------------------------------------------------------------------
// The kind strings no longer name a retired script
// ---------------------------------------------------------------------------

test('the three on-disk kinds are agent-neutral', () => {
  // They named `agent-run`, a script Phase 1 retired. Renamed agent-neutral
  // rather than to `agent-fixer`, because this phase makes all three shared
  // across agents. The `/1` version is kept: it is safe only because no record
  // has ever been written, which this phase re-measured.
  assert.equal(CLAIM_KIND, 'daftplate.agent.claim/1');
  assert.equal(RECORD_KIND, 'daftplate.agent.record/1');
  assert.equal(STOP_KIND, 'daftplate.agent.stop/1');
  for (const kind of [CLAIM_KIND, RECORD_KIND, STOP_KIND]) {
    assert.ok(!kind.includes('agent-run'), `${kind} still names a retired script`);
  }
});

test('a record written under the old kind is not read as ours', () => {
  const runs = emptyDir();
  const dir = recordsDir(REPO, { agent: 'fixer', runsDir: runs });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixer-5-x.json'), JSON.stringify({
    kind: 'daftplate.agent-run.record/1', runId: 'fixer-5-x', issue: { number: 5 },
  }));
  assert.deepEqual(listRunRecords(REPO, { runsDir: runs }), []);
});

test('claims and records for one agent do not appear under another', () => {
  const runs = emptyDir();
  claimIssue({ repoRoot: REPO, issue: 42, runId: newRunId('fixer', 42, at) }, { agent: 'fixer', runsDir: runs });
  assert.ok(existsSync(claimPath(REPO, 42, { agent: 'fixer', runsDir: runs })));
  assert.ok(!existsSync(claimPath(REPO, 42, { agent: 'hunter', runsDir: runs })));
});
