// §2.3 baseline security controls, and the one setting-repo change it implies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependabotEntry } from './helpers/dependabot.mjs';
import { REMOTE_CALLS, remoteSettings } from '../scripts/setup-repo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const standards = readFileSync(join(ROOT, 'engineering-standards', 'repo-standards.md'), 'utf8');

function sectionBody(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^#{2,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const security = sectionBody(standards, '### 2.3 Baseline security controls');

test('repo-standards gains §2.3', () => {
  assert.match(standards, /^### 2\.3 Baseline security controls$/m);
  assert.notEqual(security.trim(), '');
});

test('§2.3 explains why it sits under a section headed "Required root files"', () => {
  // The standards document's reader will never see the issue that decided this.
  assert.match(security, /Required root files/);
  assert.match(security, /§2\.1 and §2\.2 already hold/);
});

test('§2.3 frames itself as repository analogues, not as the controls themselves', () => {
  // Cyber Essentials assesses devices, networks and cloud accounts. A section
  // titled after the scheme and covering three-fifths of it, read by someone who
  // assumes the rest is handled, is the failure being avoided.
  assert.match(security, /devices, networks and cloud-service accounts/);
  assert.match(security, /repository analogues/);
  assert.match(security, /does not claim otherwise/);
});

test('§2.3 names the two controls with no repository expression', () => {
  assert.match(security, /\*\*Firewalls and Malware protection have no repository expression at all\*\*/);
  // Named again in the closing statement, so a partial reader still meets it.
  assert.match(security, /\*\*Not covered, by name:\*\* Firewalls, Malware protection/);
});

test('§2.3 requires alerts on every repo WITH A REMOTE, and admits the enforcement gap', () => {
  // The qualifier is load-bearing: --remote is an opt-in step a human runs
  // against a named repo, not something scaffolding fires.
  assert.match(security, /every repo with a GitHub remote/);
  assert.match(security, /the rule outruns its enforcement here/);
  // Alerts and dependabot.yml are different mechanisms, and conflating them is
  // how "we have a dependabot.yml" gets read as "we have alerts".
  assert.match(security, /different mechanisms/);
});

test('§2.3 requires an ecosystem entry per manager, and calls an absent-manifest entry a defect', () => {
  assert.match(security, /every package manager the repo actually uses/);
  assert.match(security, /an entry naming an absent manifest is itself a defect/);
});

test('§2.3 measures the 14-day window from vendor release, with a severity fallback', () => {
  // From the vendor's RELEASE, not the advisory's publication — they differ, and
  // the later of the two is the wrong clock to start.
  assert.match(security, /within 14 days of the vendor releasing the update/);
  assert.match(security, /not the advisory's publication/);
  assert.match(security, /CVSS v3 base score of 7\.0 or above/);
});

test('§2.3 removes end-of-life software rather than offering segregation as an equal', () => {
  assert.match(security, /end of life is removed/);
  assert.match(security, /not an equal alternative/);
});

test('§2.3 requires MFA and records the branch-protection tier caveat', () => {
  assert.match(security, /MFA is required on GitHub and on any host holding deploy credentials/);
  assert.match(security, /403 on a private repo on the free plan/);
  assert.match(security, /docs\/architecture\.md/);
});

test('§2.3 lists ungoverned access-control requirements as an open set', () => {
  // Naming a closed set of five reproduces the partial-coverage failure at a
  // smaller scale, which is the thing this whole section is written against.
  assert.match(security, /\*\*among other requirements\*\*/);
  assert.match(security, /A repository standard governs none of them/);
});

test('the standards headings renumber nothing; 2.3 and 6.6.1 are additions', () => {
  // Section numbers are cited from base-layer files that ship into repos this one
  // cannot reach into to repair, so a renumber is the failure guarded against — a
  // new subsection slotted beside its parent is not. Adding one here is the whole
  // edit a section-adding change is allowed to make to this list.
  const headings = [...standards.matchAll(/^#{2,3} (\d+(?:\.\d+)*)[. ]/gm)].map((m) => m[1]);
  assert.deepEqual(headings, [
    '1', '2', '2.1', '2.2', '2.3', '3', '4', '4.1', '4.2', '5', '5.1',
    '6', '6.1', '6.2', '6.3', '6.4', '6.5', '6.5.1', '6.6', '6.6.1',
    '7', '8', '9', '10', '11', '11.1', '12',
  ]);
});

test('neither Dependabot config changed: still one github-actions ecosystem', () => {
  // The npm entry an earlier draft would have added is withdrawn: no
  // package.json template ships, so the entry would name an absent manifest and
  // Dependabot would report a configuration error on every run.
  for (const rel of ['.github/dependabot.yml', 'base/files/dot-github/dependabot.yml']) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(dependabotEntry(text, 'github-actions'), `${rel} lost its github-actions entry`);
    const ecosystems = [...text.matchAll(/^\s*-\s+package-ecosystem:/gm)];
    assert.equal(ecosystems.length, 1, `${rel} declares ${ecosystems.length} ecosystems`);
  }
});

test('remoteSettings offers dependabot-alerts whenever the repo is reachable', () => {
  const byId = (settings) => Object.fromEntries(settings.map((s) => [s.id, s]));

  // No invented tier gate: there is no known plan or visibility gate on this
  // endpoint, so a real 403 must land on the existing `failed` path instead.
  const privateFree = byId(remoteSettings({ slug: 'o/r', private: true, plan: 'free', reachable: true }));
  assert.equal(privateFree['dependabot-alerts'].available, true);

  const unreachable = byId(remoteSettings({ slug: 'o/r', private: true, plan: null, reachable: false }));
  assert.equal(unreachable['dependabot-alerts'].available, false);
  assert.match(unreachable['dependabot-alerts'].reason, /not reachable/);
});

test('the alerts call is exactly a PUT to vulnerability-alerts, and never the fixes endpoint', () => {
  // automated-security-fixes lets Dependabot open PRs unprompted, which is a
  // different decision from being told about a vulnerability.
  assert.deepEqual(REMOTE_CALLS['dependabot-alerts']('o/r'), [
    'api', '--method', 'PUT', 'repos/o/r/vulnerability-alerts',
  ]);
  const source = readFileSync(join(ROOT, 'scripts', 'setup-repo.mjs'), 'utf8');
  assert.doesNotMatch(source, /--method', 'PUT', `repos\/\$\{slug\}\/automated-security-fixes/);
  assert.doesNotMatch(security, /automated security fixes are required|enable automated security fixes/i);
});
