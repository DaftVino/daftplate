import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRemote, ghJson, main, probeRemote, remoteSettings } from '../scripts/setup-repo.mjs';

const fakeRun = (responses) => (args) => {
  const key = args.join(' ');
  return responses[key] ?? { status: 1, stdout: '', stderr: 'not found' };
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

test('probeRemote reports visibility and plan for a reachable repo', () => {
  const run = fakeRun({
    'api repos/o/r': {
      status: 0,
      stdout: JSON.stringify({ private: true, owner: { type: 'User' }, plan: { name: 'free' } }),
      stderr: '',
    },
  });

  assert.deepEqual(probeRemote('o/r', run), {
    slug: 'o/r', private: true, plan: 'free', reachable: true,
  });
});

test('probeRemote marks an unreachable repo rather than throwing', () => {
  const probe = probeRemote('o/missing', fakeRun({}));
  assert.equal(probe.reachable, false);
  assert.equal(probe.slug, 'o/missing');
});

test('probeRemote treats a missing plan block as free', () => {
  const run = fakeRun({
    'api repos/o/r': { status: 0, stdout: JSON.stringify({ private: false, owner: { type: 'User' } }), stderr: '' },
  });
  assert.equal(probeRemote('o/r', run).plan, 'free');
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
    'api repos/o/r': { status: 0, stdout: JSON.stringify({ private: false, plan: { name: 'free' } }), stderr: '' },
  });
  assert.equal(main(['node', 'setup-repo.mjs', '.', '--remote'], run), 0);
});

test('main --remote returns 0 when settings are merely unavailable', () => {
  const run = remoteRun({
    'repo view': { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' },
    'api repos/o/r': { status: 0, stdout: JSON.stringify({ private: true, plan: { name: 'free' } }), stderr: '' },
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
    if (key.includes('repos/o/r')) return { status: 0, stdout: JSON.stringify({ private: false, plan: { name: 'free' } }), stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  };
  assert.equal(main(['node', 'setup-repo.mjs', '.', '--remote'], run), 1);
});
