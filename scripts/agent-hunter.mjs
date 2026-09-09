#!/usr/bin/env node
// The hunt runner, in the only mode it has: report-only. `#194 (FORGE-260)`,
// Phase 1 of docs/designs/2026-08-27-plan-issue-hunters.md.
//
// Two halves, deliberately separated, for the reason scripts/deliberate.mjs is
// shaped the same way: this module PLANS the invocations and INGESTS what comes
// back, and the agent driving it does the invoking. Nothing here spawns. A
// script that spawned five subagents would put the argv safety properties behind
// a process boundary the suite cannot see, whereas a plan is a value a test can
// assert over — which is exactly what AC 9 asks for.
//
// Usage: node scripts/agent-hunter.mjs <repo> [--lens <id>]... [--run-id <id>]
//        node scripts/agent-hunter.mjs <repo> --ingest <answers-dir> [--out <path>]
//
// **A hunt is a run.** `#194 (FORGE-260)` Phase 7. The planning half opens a
// record in the ledger `agent-fixer.mjs --list` reads and the `/daft-agent` menu
// renders, and the ingesting half closes it — so a hunt is discoverable by a
// process that did not start it (ADR 0008 row 8) and leaves a durable record
// outside any worktree (row 9, for the report-only mode: it changes nothing and
// publishes nothing but its report, and the record says so rather than leaving
// the fields to be guessed at). The two halves are two processes and the run id
// is what joins them: the plan prints it, and `--ingest --run-id <id>` closes it.
//
// **This phase files nothing.** No issue is created here, in GitHub or in
// Linear, by this script or by anything it plans. Filing is Phase 4 and it is
// gated on per-lens precision that does not exist yet; closing is ADR 0008 row
// 6's "never". tests/agent-hunter.test.mjs asserts both over this file's own source.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  LENSES, LENS_IDS, lensById, buildInvocation,
  MODE_REPORT_ONLY, PERMISSION_MODE, PERMITTED_OPERATIONS, assertOperationsPermitted,
  normalizeFindings, SEVERITIES,
} from './lib/lenses.mjs';
import { runCli, reportViolations, EXIT_CODES } from './lib/cli.mjs';
import { recordEndOnExit } from './lib/agent-state.mjs';
import { agentForRunId } from './lib/worktree.mjs';
import {
  openRunRecord, recordInvocation, closeRunRecord, checkStop, markStopped,
  RUN_STATES, RECORD_REFUSALS,
} from './lib/run-record.mjs';

export { MODE_REPORT_ONLY, PERMITTED_OPERATIONS };

/** The operations a Phase 1 run performs, named rather than implied. Asserted
 *  against PERMITTED_OPERATIONS at plan time, so a phase that quietly acquires
 *  authority fails where it acquired it. */
export const RUN_OPERATIONS = Object.freeze(['read-repository', 'invoke-doctrine', 'write-report']);

/** The registry id this runner writes its records under. Named once so the three
 *  record calls below cannot disagree about which directory a hunt lives in —
 *  `agentRoot` throws without it, and the pre-Phase-2 flat layout it would
 *  otherwise fall back to is the one both agents shared. */
export const HUNTER_AGENT = 'hunter';

/**
 * A run id for a hunt, which has no issue to key on.
 *
 * **The agent prefix is load-bearing rather than decorative.** `agentForRunId`
 * reads it, and that is how `agent-fixer.mjs --stop <run id>` — the runs CLI for
 * every agent (D9) — finds a hunt's record without being told which agent
 * produced it, which is ADR 0008 row 8's "by a human who did not start it". An id
 * naming no agent resolves only for a caller that already knows, which is the
 * thing row 8 says a human will not.
 *
 * The timestamp is `newRunId`'s formula and `tests/agent-hunter.test.mjs` pins
 * the two against each other for one instant, because two spellings of the same
 * shape is how one of them quietly stops matching `RUN_ID_CHARSET`.
 */
export function newHuntRunId(at = new Date()) {
  return `${HUNTER_AGENT}-${at.toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`;
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { dir: null, lenses: [], ingest: null, out: null, scheduled: false, runsDir: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    // Parsed rather than thrown on. The sweeper passes this, and a flag that
    // arrives as a usage error under `stdio: 'ignore'` is a launch that failed
    // where nobody could see it — which is exactly how `#223 (FORGE-294)` defect 1
    // stayed invisible. Understanding it is what makes the refusal below sayable.
    if (arg === '--scheduled') { opts.scheduled = true; continue; }
    if (arg === '--lens') { opts.lenses.push(args[i += 1]); continue; }
    if (arg === '--ingest') { opts.ingest = args[i += 1]; continue; }
    if (arg === '--out') { opts.out = args[i += 1]; continue; }
    if (arg === '--run-id') { opts.runId = args[i += 1]; continue; }
    // The fixer's flag NAME, because both CLIs write into the same ledger and a
    // test that could redirect one but not the other would have to reach the real
    // `~/.daftplate/runs/` to exercise this one. The argument style is this
    // parser's own — space-separated, like every other flag here, where the
    // fixer's parser takes `--runs-dir=<path>`. Matching the name and not the
    // form is deliberate: a reader of either CLI's usage line gets the right
    // answer, and neither parser grows a second spelling of its own flags.
    if (arg === '--runs-dir') { opts.runsDir = args[i += 1]; continue; }
    if (arg.startsWith('--')) throw new Error(`hunt: unknown option ${arg}`);
    if (opts.dir === null) opts.dir = arg;
  }
  // No default. The repository a run points at becomes the `cwd` of every
  // invocation, and ADR 0008 row 2 makes that the security-relevant choice —
  // never the developer's checkout. A `.` default would silently aim a run at
  // wherever the caller happened to be standing, so it has to be said out loud.
  if (opts.dir === null) throw new Error('hunt: no repository given');
  // Refused here rather than at the first record write, where it surfaces as
  // `assertRunIdAgent`'s mismatch thrown out of a path builder — a stack trace
  // for what is a typo on the command line. An id naming no agent at all is
  // still allowed, for `assertRunIdAgent`'s own reason: a caller's own scheme
  // contradicts nothing, and only a DIFFERENT known agent is a disagreement.
  const named = opts.runId ? agentForRunId(opts.runId) : null;
  if (named && named !== HUNTER_AGENT) {
    throw new Error(`hunt: --run-id \`${opts.runId}\` names agent \`${named}\`, not ${HUNTER_AGENT}`);
  }
  return opts;
}

/** The lenses a run covers. An unknown id is refused rather than skipped: a run
 *  asked for a lens it does not have and reporting a clean sweep has answered a
 *  question nobody asked. */
export function selectLenses(ids) {
  if (!ids || ids.length === 0) return LENSES;
  return ids.map((id) => {
    const lens = lensById(id);
    if (!lens) throw new Error(`hunt: unknown lens "${id}"; known lenses are ${LENS_IDS.join(', ')}`);
    return lens;
  });
}

export function buildPlan(dir, { lenses, runId } = {}) {
  const selected = selectLenses(lenses);
  assertOperationsPermitted(RUN_OPERATIONS);
  return {
    mode: MODE_REPORT_ONLY,
    runId: runId ?? 'hunt',
    repoRoot: dir,
    operations: RUN_OPERATIONS,
    invocations: selected.map((lens) => buildInvocation(lens, { repoRoot: dir, runId: runId ?? 'hunt' })),
  };
}

/** Read one `<lens>.json` per lens out of an answers directory. A lens with no
 *  file is reported as unanswered, never as clean: those are different results
 *  and Phase 3 measures precision over the difference. */
export function readAnswers(ingestDir, lenses) {
  const answers = [];
  for (const lens of lenses) {
    const path = join(ingestDir, `${lens.id}.json`);
    if (!existsSync(path)) { answers.push({ lens: lens.id, answered: false, raws: [] }); continue; }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const raws = Array.isArray(parsed) ? parsed : parsed.findings;
    if (!Array.isArray(raws)) throw new Error(`hunt: ${path} holds neither an array nor a findings array`);
    answers.push({ lens: lens.id, answered: true, raws });
  }
  return answers;
}

export function collect(answers) {
  const perLens = answers.map((answer) => {
    const { accepted, rejected } = normalizeFindings(answer.raws);
    return { lens: answer.lens, answered: answer.answered, accepted, rejected };
  });
  return {
    perLens,
    findings: perLens.flatMap((l) => l.accepted),
    rejected: perLens.flatMap((l) => l.rejected.map((r) => ({ ...r, lens: l.lens }))),
  };
}

const severityRank = (s) => SEVERITIES.indexOf(s);

export function renderReport(plan, collected) {
  const { perLens, findings, rejected } = collected;
  const lines = [];
  lines.push(`# Hunt run ${plan.runId}`);
  lines.push('');
  lines.push(`**Mode:** \`${plan.mode}\` — nothing was filed. No issue was created in GitHub or in`);
  lines.push('Linear by this run, and none could be: filing arrives in Phase 4 of');
  lines.push('`docs/designs/2026-08-27-plan-issue-hunters.md`, gated on per-lens precision that');
  lines.push('does not exist yet. `#194 (FORGE-260)`.');
  lines.push('');
  lines.push(`**Repository:** \`${plan.repoRoot}\` · **Operations:** ${plan.operations.join(', ')}`);
  lines.push('');
  lines.push('## Findings per lens');
  lines.push('');
  lines.push('| Lens | Doctrine | Answered | Findings | Reproduced | Reasoned | Rejected |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const l of perLens) {
    const lens = lensById(l.lens);
    const reproduced = l.accepted.filter((f) => f.evidence === 'reproduced').length;
    lines.push(`| ${lens.title} | \`${lens.doctrine}\` | ${l.answered ? 'yes' : '**no**'} | ${l.accepted.length} | ${reproduced} | ${l.accepted.length - reproduced} | ${l.rejected.length} |`);
  }
  lines.push('');

  const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  lines.push('## Findings');
  lines.push('');
  if (!sorted.length) lines.push('None accepted.');
  for (const f of sorted) {
    lines.push(`### ${f.summary}`);
    lines.push('');
    lines.push(`- **Lens:** ${f.lens} (${f.provenance.doctrine}, invocation \`${f.provenance.invocation}\`)`);
    lines.push(`- **Location:** \`${f.path}\`${f.symbol ? ` · \`${f.symbol}\`` : ' · file-level'}`);
    lines.push(`- **Class:** ${f.defectClass}`);
    lines.push(`- **Severity:** ${f.severity} — ${f.severityReasoning}`);
    // #194 (FORGE-260) D8. A structured reproduction is carried through rather
    // than stringified: interpolating it here rendered `[object Object]`, which
    // is the same loss the ingest refusal used to cause, one step later. The
    // shape is the command and its output in a fence, because rerunnability is
    // the entire reason the field exists.
    if (f.evidence !== 'reproduced') {
      lines.push('- **Evidence:** reasoned — not reproduced, this is reasoning about the code rather than an observation of it');
      lines.push('');
    } else if (typeof f.reproduction === 'string') {
      lines.push(`- **Evidence:** reproduced — ${f.reproduction}`);
      lines.push('');
    } else {
      lines.push('- **Evidence:** reproduced');
      lines.push('');
      lines.push('```');
      lines.push(`$ ${f.reproduction.command}`);
      lines.push(f.reproduction.output);
      lines.push('```');
      lines.push('');
    }
    lines.push(f.detail);
    lines.push('');
  }

  lines.push('## Rejected answers');
  lines.push('');
  if (!rejected.length) {
    lines.push('None. Every answer returned took the finding shape.');
  } else {
    lines.push('Answers a lens returned that are not findings. They are reported rather than');
    lines.push('dropped: a run that silently discarded them would show a clean lens and a quiet');
    lines.push('loss.');
    lines.push('');
    for (const r of rejected) {
      lines.push(`- \`${r.lens}\` finding[${r.index}]: ${r.violations.map((v) => `${v.rule} — ${v.message}`).join('; ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

const USAGE = [
  'usage: node scripts/agent-hunter.mjs <repo> [--lens <id>]... [--run-id <id>] [--runs-dir <path>]',
  '       node scripts/agent-hunter.mjs <repo> --ingest <answers-dir> [--out <path>] [--run-id <id>]',
].join('\n');

/**
 * The two halves of a hunt are two processes, and the record spans both.
 *
 * **`pid` is null and that is the honest value.** `openRunRecord` defaults it to
 * `process.pid`, which is right for the fixer, whose runner process lives for the
 * whole run. A hunt's planning process prints a plan and exits; the thing that
 * holds the run open is the *session* performing the invocations, whose pid this
 * script never learns. Stamping this process's pid would make `holderAlive`
 * report a live holder for the two milliseconds before it exits and a dead one
 * ever after — a confident answer to a question this half of the run cannot
 * answer at all. Null is `holderAlive`'s false, and the CLI that prints it says
 * why rather than reporting a corpse.
 */
function openHunt(repoRoot, plan, argv, io) {
  const opened = openRunRecord({
    repoRoot, runId: plan.runId, issue: null, permissionMode: PERMISSION_MODE, pid: null,
  }, io);
  if (!opened.ok) return opened;
  // What ran, for row 9. The argv of the planner rather than of the lens
  // invocations: the record holds one `ran`, five lenses would overwrite each
  // other in it, and the argv that produced the plan is the one an operator can
  // rerun. The prompts are deliberately not recorded — they are five, they are
  // large, and `buildPrompt` composes them from doctrine files already in the
  // repository at `changed.baseCommit`.
  recordInvocation(repoRoot, plan.runId, { command: 'agent-hunter.mjs', args: argv.slice(2) }, io);
  return opened;
}

function main(argv) {
  let opts;
  let plan;
  try {
    opts = parseArgs(argv);
    plan = buildPlan(opts.dir, { lenses: opts.lenses, runId: opts.runId ?? newHuntRunId() });
  } catch (err) {
    // Usage, not failure: a run asked for something this runner does not have has
    // not found zero defects, and the two exit codes must not read the same.
    console.error(`${err.message}\n${USAGE}`);
    return EXIT_CODES.USAGE;
  }

  if (opts.scheduled) {
    // #194 (FORGE-260) Phase 4. Kept deliberately, and its limits stated: the
    // sweeper never spawns this agent (`driver: 'none'`), so this handler can only
    // fire when a human types the argv by hand or a test spawns it directly. It is
    // NOT evidence that the fleet is observable, and it must not be counted as
    // such -- it is here so the two CLIs behave the same way and so the
    // direct-spawn path in tests/agent-sweep-argv.test.mjs leaves a record.
    recordEndOnExit('hunter');

    // Before the plan is printed, because a scheduled tick that received a plan
    // would have nowhere to send it and the JSON would go to a closed stdio. The
    // registry says the same thing in `unattended.driver: 'none'`, so the sweeper
    // does not start this at all; this branch is what makes that declaration
    // checkable from outside, and what answers anyone who runs the argv by hand.
    console.error('hunt: no unattended driver — a hunt is invoked by a session, which performs'
      + ' the invocations this script plans and hands back the answers it ingests');
    return EXIT_CODES.NO_DRIVER;
  }

  // Below the `--scheduled` branch on purpose: a tick the sweeper refuses is not
  // a run, and a record opened for one would put a hunt nobody started into
  // `--list`. The refusal happens before anything is written, exactly as it does
  // before anything is spawned.
  const repoRoot = resolve(opts.dir);
  const io = { runsDir: opts.runsDir, agent: HUNTER_AGENT };

  if (!opts.ingest) {
    // ADR 0008 row 8, first half. Before the plan is printed, so a session that
    // acts on the plan is acting on a run that is already discoverable — the
    // other order leaves a window in which invocations are under way and nothing
    // outside this process knows a hunt exists.
    const opened = openHunt(repoRoot, plan, argv, io);
    if (!opened.ok) {
      console.error(`hunt: could not open a run record for ${plan.runId} — ${opened.reason}`
        + (opened.reason === RECORD_REFUSALS.EXISTS ? ' (choose another --run-id)' : '')
        + '\na hunt that is not in the ledger cannot be found or stopped by anyone else, so this'
        + ' one does not start');
      return EXIT_CODES.USAGE;
    }
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  if (opts.runId) {
    // ADR 0008 row 8, second half, at the one boundary this runner owns. A hunt's
    // lens invocations are performed by a session and nothing here polls between
    // them, so this honours a stop that arrived while they were running — it does
    // not interrupt one. The residual is named in the plan's handoff log rather
    // than papered over: a stop is obeyed at ingest, not mid-flight.
    const stop = checkStop(repoRoot, opts.runId, io);
    if (stop) {
      const marked = markStopped(repoRoot, opts.runId, stop, io);
      console.error(`hunt ${opts.runId} was asked to stop at ${stop.requestedAt}`
        + `${stop.reason ? ` — ${stop.reason}` : ''}${stop.by ? ` (by ${stop.by})` : ''}`);
      console.error(marked.ok
        ? 'nothing was ingested and the record is closed as stopped'
        : `nothing was ingested; the record could not be closed — ${marked.reason}`);
      return EXIT_CODES.STOPPED;
    }
  } else {
    // Said out loud, because the failure it warns about is silent: the plan half
    // opened a record, and an ingest that closes none leaves that run `running`
    // in `--list` for ever, which is a discovery surface telling an operator a
    // hunt is under way when it finished an hour ago.
    console.error('hunt: no --run-id, so this ingest closes no run record — pass back the'
      + ' `runId` the plan printed, or the run stays open in `--list`');
  }

  const collected = collect(readAnswers(opts.ingest, selectLenses(opts.lenses)));
  const report = renderReport(plan, collected);
  if (opts.out) writeFileSync(resolve(opts.out), report, 'utf8');
  else console.log(report);

  if (opts.runId) {
    // `REPORTED`, never `PUBLISHED`, and the shape is the publisher's own rather
    // than a second one invented here. A hunt changes nothing and publishes
    // nothing but the report, so `changed.files` and `published.commit` stay null
    // — which is row 9's honest answer for a report-only run, and is why the row
    // is recorded as met for this mode alone.
    const closed = closeRunRecord(repoRoot, opts.runId, {
      publish: {
        outcome: RUN_STATES.REPORTED,
        comment: opts.out ? { path: resolve(opts.out) } : null,
      },
    }, io);
    if (!closed.ok) console.error(`hunt: the run record for ${opts.runId} was not closed — ${closed.reason}`);
  }

  // The count of filings is a literal zero because there is no code path that
  // could make it anything else. Stated in the output rather than assumed.
  console.log(`${collected.findings.length} finding(s), ${collected.rejected.length} rejected, 0 filed`);
  return reportViolations(collected.rejected.flatMap((r) => r.violations));
}

export { main };
runCli(import.meta.url, main);
