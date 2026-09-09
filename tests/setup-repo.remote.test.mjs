import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRemote, availableCheckContexts, ghJson, main, probeRemote, REMOTE_CALLS, remoteSettings } from '../scripts/setup-repo.mjs';
import { makeRepo } from './helpers/make-repo.mjs';

const fakeRun = (responses) => (args) => {
  const key = args.join(' ');
  return responses[key] ?? { status: 1, stdout: '', stderr: 'not found' };
};

// Records every call so we can assert which verb and path were used.
const recordingRun = (responses) => {
  const calls = [];
  const run = (args, cwd, input) => {
    calls.push({ key: args.join(' '), input });
    return responses[args.join(' ')] ?? { status: 1, stdout: '', stderr: 'not found' };
  };
  return { run, calls };
};

test('ghJson parses stdout on success', () => {
  const run = fakeRun({ 'api repos/o/r': { status: 0, stdout: '{"private":true}', stderr: '' } });
  assert.deepEqual(ghJson(['api', 'repos/o/r'], run), { private: true });
});

test('ghJson returns null on a non-zero exit', () => {
  const run = fakeRun({ 'api repos/o/r': { status: 1, stdout: '', stderr: '403' } });
  assert.equal(ghJson(['api', 'repos/o/r'], run), null);
});

test('ghJson returns null on unparseable output rather than throwing', () => {
  const run = fakeRun({ 'api repos/o/r': { status: 0, stdout: 'not json', stderr: '' } });
  assert.equal(ghJson(['api', 'repos/o/r'], run), null);
});

// The repository payload carries NO plan key — verified against the raw live API
// and pinned in tests/github-payload-contract.test.mjs. Every mock below reflects
// that. `probeRemote treats a missing plan block as free` used to live here; it is
// DELETED rather than inverted, because its subject was the repository payload's
// plan block and there is no such thing. Its replacement is a different assertion
// about a different endpoint.
const repoPayload = (over = {}) => JSON.stringify({
  private: true, owner: { login: 'o', type: 'User' }, ...over,
});

test('probeRemote reports visibility and the owner account plan for a reachable repo', () => {
  const run = fakeRun({
    'api repos/o/r': { status: 0, stdout: repoPayload(), stderr: '' },
    'api user': { status: 0, stdout: JSON.stringify({ login: 'o', plan: { name: 'pro' } }), stderr: '' },
  });

  assert.deepEqual(probeRemote('o/r', run), {
    slug: 'o/r', private: true, plan: 'pro', reachable: true,
  });
});

test('probeRemote marks an unreachable repo rather than throwing', () => {
  const probe = probeRemote('o/missing', fakeRun({}));
  assert.equal(probe.reachable, false);
  assert.equal(probe.slug, 'o/missing');
  // Unknown, not free: an unreachable repo tells us nothing about its tier.
  assert.equal(probe.plan, null);
});

test('a foreign user-owned repo does not inherit the authenticated user plan', () => {
  // `api user` reports whoever holds the token. Accepting its plan for somebody
  // else's repository would hand a stranger's repo this machine's tier.
  const run = fakeRun({
    'api repos/other/r': {
      status: 0,
      stdout: JSON.stringify({ private: true, owner: { login: 'other', type: 'User' } }),
      stderr: '',
    },
    'api user': { status: 0, stdout: JSON.stringify({ login: 'me', plan: { name: 'pro' } }), stderr: '' },
  });

  assert.equal(probeRemote('other/r', run).plan, null);
});

test('an organization owner routes to orgs/{login}, not to the repo slug', () => {
  const { run, calls } = recordingRun({
    'api repos/an-org/r': {
      status: 0,
      stdout: JSON.stringify({ private: true, owner: { login: 'an-org', type: 'Organization' } }),
      stderr: '',
    },
    'api orgs/an-org': { status: 0, stdout: JSON.stringify({ plan: { name: 'team' } }), stderr: '' },
  });

  assert.equal(probeRemote('an-org/r', run).plan, 'team');
  assert.deepEqual(calls.map((c) => c.key), ['api repos/an-org/r', 'api orgs/an-org']);
  // Never `api user` for an organization, and never the slug where the login goes.
  assert.equal(calls.some((c) => c.key === 'api user'), false);
});

test('a successful account response carrying no plan yields null, not free', () => {
  // The measured case for an organization the caller does not administer: plan
  // data needs membership and scope, so the key is simply absent.
  const run = fakeRun({
    'api repos/an-org/r': {
      status: 0,
      stdout: JSON.stringify({ private: true, owner: { login: 'an-org', type: 'Organization' } }),
      stderr: '',
    },
    'api orgs/an-org': { status: 0, stdout: JSON.stringify({ login: 'an-org' }), stderr: '' },
  });

  assert.equal(probeRemote('an-org/r', run).plan, null);
});

test('a failed account lookup leaves a reachable repo at an unknown plan', () => {
  // Account lookup failing is not the repository being unreachable, and it is not
  // evidence of a free plan either.
  const run = fakeRun({
    'api repos/o/r': { status: 0, stdout: repoPayload(), stderr: '' },
  });
  const probe = probeRemote('o/r', run);

  assert.equal(probe.reachable, true);
  assert.equal(probe.plan, null);
});

test('a private repo with an unknown plan still attempts branch protection', () => {
  // The whole point of keeping null distinct from free. A wrong `free` is silent
  // and self-confirming; a wrong `pro` is one 403 that applyRemote already reports.
  const unknown = byId(remoteSettings({ slug: 'o/r', private: true, plan: null, reachable: true }));
  assert.equal(unknown['branch-protection'].available, true);

  const explicitFree = byId(remoteSettings({ slug: 'o/r', private: true, plan: 'free', reachable: true }));
  assert.equal(explicitFree['branch-protection'].available, false);
});

const byId = (settings) => Object.fromEntries(settings.map((s) => [s.id, s]));

test('a private free repo can set repo options but not protection or scanning', () => {
  const s = byId(remoteSettings({ slug: 'o/r', private: true, plan: 'free', reachable: true }));

  assert.equal(s['delete-branch-on-merge'].available, true);
  assert.equal(s['branch-protection'].available, false);
  assert.match(s['branch-protection'].reason, /private repo on the free plan/);
  assert.match(s['branch-protection'].unblock, /Pro|public/);
  assert.equal(s['secret-scanning'].available, false);
  assert.match(s['secret-scanning'].unblock, /public/);
});

test('a public repo can set all three regardless of plan', () => {
  const s = byId(remoteSettings({ slug: 'o/r', private: false, plan: 'free', reachable: true }));

  assert.equal(s['delete-branch-on-merge'].available, true);
  assert.equal(s['branch-protection'].available, true);
  assert.equal(s['secret-scanning'].available, true);
});

test('a private repo on Pro gains branch protection but not secret scanning', () => {
  const s = byId(remoteSettings({ slug: 'o/r', private: true, plan: 'pro', reachable: true }));

  assert.equal(s['branch-protection'].available, true);
  assert.equal(s['secret-scanning'].available, false);
  assert.match(s['secret-scanning'].reason, /Advanced Security/);
});

test('nothing is available on an unreachable repo', () => {
  for (const s of remoteSettings({ slug: 'o/r', private: true, plan: 'free', reachable: false })) {
    assert.equal(s.available, false);
    assert.match(s.reason, /not reachable/);
  }
});

test('every unavailable setting states both a reason and an unblock condition', () => {
  const probes = [
    { slug: 'o/r', private: true, plan: 'free', reachable: true },
    { slug: 'o/r', private: true, plan: 'pro', reachable: true },
    { slug: 'o/r', private: true, plan: 'free', reachable: false },
  ];
  for (const probe of probes) {
    for (const s of remoteSettings(probe).filter((x) => !x.available)) {
      assert.notEqual(s.reason, '', `${s.id} has no reason`);
      assert.notEqual(s.unblock, '', `${s.id} has no unblock condition`);
    }
  }
});

const publicProbe = { slug: 'o/r', private: false, plan: 'free', reachable: true };
const privateProbe = { slug: 'o/r', private: true, plan: 'free', reachable: true };

test('applyRemote issues no gh calls under --dry-run', () => {
  const calls = [];
  const run = (args) => { calls.push(args.join(' ')); return { status: 0, stdout: '{}', stderr: '' }; };

  const results = applyRemote(publicProbe, { run, dryRun: true });

  assert.deepEqual(calls, []);
  assert.equal(results.every((r) => r.status === 'skipped' || r.status === 'unavailable'), true);
});

test('applyRemote applies each available setting and reports success', () => {
  const calls = [];
  const run = (args) => { calls.push(args.join(' ')); return { status: 0, stdout: '{}', stderr: '' }; };

  const results = applyRemote(publicProbe, { run });

  assert.equal(results.every((r) => r.status === 'applied'), true);
  assert.equal(calls.some((c) => c.includes('delete_branch_on_merge')), true);
  assert.equal(calls.some((c) => c.includes('branches/main/protection')), true);
  assert.equal(calls.some((c) => c.includes('secret-scanning') || c.includes('security_and_analysis')), true);
});

test('applyRemote never calls gh for an unavailable setting', () => {
  const calls = [];
  const run = (args) => { calls.push(args.join(' ')); return { status: 0, stdout: '{}', stderr: '' }; };

  const results = applyRemote(privateProbe, { run });
  const protection = results.find((r) => r.id === 'branch-protection');

  assert.equal(protection.status, 'unavailable');
  assert.match(protection.detail, /free plan/);
  assert.equal(calls.some((c) => c.includes('protection')), false);
});

test('applyRemote reports a failed call without throwing, and keeps going', () => {
  const run = (args) => (args.join(' ').includes('protection')
    ? { status: 1, stdout: '', stderr: 'HTTP 422' }
    : { status: 0, stdout: '{}', stderr: '' });

  const results = applyRemote(publicProbe, { run });

  assert.equal(results.find((r) => r.id === 'branch-protection').status, 'failed');
  assert.match(results.find((r) => r.id === 'branch-protection').detail, /422/);
  assert.equal(results.find((r) => r.id === 'delete-branch-on-merge').status, 'applied');
});

test('availableCheckContexts returns the job contexts a repo actually ships', () => {
  const repo = makeRepo({
    '.github/workflows/ci.yml': 'name: ci\non:\n  push:\njobs:\n  test:\n    runs-on: x\n  secrets:\n    runs-on: x\n',
  });
  assert.deepEqual(availableCheckContexts(repo).sort(), ['secrets', 'test']);
});

test('availableCheckContexts is empty when the repo ships no workflows', () => {
  assert.deepEqual(availableCheckContexts(makeRepo({ 'README.md': 'x' })), []);
});

test('availableCheckContexts requires only the jobs that exist', () => {
  const repo = makeRepo({ '.github/workflows/ci.yml': 'jobs:\n  test:\n    runs-on: x\n' });
  assert.deepEqual(availableCheckContexts(repo), ['test']);
});

test('applyRemote requires only the check contexts it is given', () => {
  const calls = [];
  const run = (args) => { calls.push(args.join(' ')); return { status: 0, stdout: '{}', stderr: '' }; };
  applyRemote(publicProbe, { run, contexts: ['test'] });
  const prot = calls.find((c) => c.includes('branches/main/protection'));
  assert.match(prot, /required_status_checks\[contexts\]\[\]=test/);
  assert.doesNotMatch(prot, /contexts\]\[\]=secrets/);
});

test('applyRemote requires no status checks when given none (a check-less repo)', () => {
  const calls = [];
  const run = (args) => { calls.push(args.join(' ')); return { status: 0, stdout: '{}', stderr: '' }; };
  applyRemote(publicProbe, { run, contexts: [] });
  const prot = calls.find((c) => c.includes('branches/main/protection'));
  assert.match(prot, /required_status_checks=null/);
  assert.doesNotMatch(prot, /contexts\]\[\]/);
  // still requires a PR — direct pushes to main stay blocked
  assert.match(prot, /required_pull_request_reviews/);
});

const remoteRun = (responses) => (args) => {
  const key = args.join(' ');
  for (const [match, response] of Object.entries(responses)) {
    if (key.includes(match)) return response;
  }
  return { status: 0, stdout: '{}', stderr: '' };
};

test('main --remote returns 1 when the repo has no GitHub remote', () => {
  const run = () => ({ status: 1, stdout: '', stderr: 'no remote' });
  assert.equal(main(['node', 'setup-repo.mjs', '.', '--remote'], run), 1);
});

test('main --remote returns 0 when everything applies', () => {
  const run = remoteRun({
    'repo view': { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' },
    // Checked before the narrower 'api repos/o/r' entry below, since that
    // string is a prefix of this call's key too — order matters for
    // remoteRun's substring match.
    'repos/o/r/rulesets': { status: 0, stdout: '[]', stderr: '' },
    'api repos/o/r': { status: 0, stdout: JSON.stringify({ private: false, owner: { login: 'o', type: 'User' } }), stderr: '' },
  });
  assert.equal(main(['node', 'setup-repo.mjs', '.', '--remote'], run), 0);
});

test('main --remote returns 0 when settings are merely unavailable', () => {
  const run = remoteRun({
    'repo view': { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' },
    'api repos/o/r': { status: 0, stdout: JSON.stringify({ private: true, owner: { login: 'o', type: 'User' } }), stderr: '' },
  });
  // A structural impossibility is not an error.
  assert.equal(main(['node', 'setup-repo.mjs', '.', '--remote'], run), 0);
});

test('main --remote returns 1 when an applicable gh call fails', () => {
  const run = (args) => {
    const key = args.join(' ');
    // Match on a substring the real arg vector actually contains: every write
    // call carries `--method <VERB>` between `api` and the path, so `api repos/o/r`
    // never occurs on one. Only the probe joins to exactly `api repos/o/r`.
    if (key.includes('repo view')) return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
    if (key.includes('branches/main/protection')) return { status: 1, stdout: '', stderr: 'HTTP 422' };
    if (key.includes('repos/o/r')) return { status: 0, stdout: JSON.stringify({ private: false, owner: { login: 'o', type: 'User' } }), stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  };
  assert.equal(main(['node', 'setup-repo.mjs', '.', '--remote'], run), 1);
});

// The guard that survives the copilot removal, and the reason it must: a setting
// listed by remoteSettings() with no way to apply it takes down every other
// setting in the same map call, which is how four settings once broke over one.
test('every remote setting is dispatchable', () => {
  for (const s of remoteSettings({ slug: 'o/r', private: false, plan: 'free', reachable: true })) {
    assert.ok(s.id in REMOTE_CALLS, `${s.id} has no applier`);
  }
});
