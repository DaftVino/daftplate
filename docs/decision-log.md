# Decision log

A public, sanitized summary of the architectural decisions behind daftplate. The full Architecture Decision Records — with their private context — stay in the private working repo; this is their public-safe face (ADR 0005). Each entry states what was decided and why, and what would justify revisiting it.

## Standards are canonical here (ADR 0001)

**Decided:** the engineering standards live in exactly one place. A repo produced by daftplate gets a one-line pointer to them plus a small quick-reference copy — never a full vendored copy. A verifier fails any produced repo that contains a vendored standards directory.

**Why:** copies drift, and each vendored copy adds a large body of text an agent wanders into, spending its limited context on rules it already has globally. A pointer cannot drift, and the one small quick-reference is cheap enough that its drift does not matter. Revisit only if a repo must routinely be worked on with no access to the canonical source.

## Skills are installed user-level (ADR 0002)

**Decided:** the skills are sourced in this repo and installed into the developer's user-level agent directory as **one plugin**, under a single directory the repo owns, rather than as one directory per skill. The installer copies over the top and never deletes. Skills that only make sense inside one project kind are the exception — they ship into that project's own repo-scoped directory.

**Why:** the skills that create or orient a project must work from *outside* any single repo, so they cannot be repo-scoped. The no-delete rule is a blast-radius decision: the target directory holds every other skill the developer uses, and an unguarded delete keyed on this repo's contents is not worth the tidiness it would buy. One owned subtree is what makes that boundary nameable — with a directory per skill, a name collision silently overwrote somebody else's skill and nothing could detect it; inside one owned directory there is nothing of theirs to collide with.

**Amended 2026-09-02, and the amendment is the interesting half.** Loose directories installed by the earlier shape do not disappear, because the installer still may not delete them. Measured rather than assumed: when a loose skill and a plugin skill share a plain name, **the loose one wins it**, and the plugin's copy stays reachable only under its qualified name. So removing them is a prerequisite rather than a tidy-up — until they are gone the new install has not taken effect — and the installer *names* the directories it has verified are its own and prints the removal command for a human to run. It also refuses to install at all while a stray skill occupies the path its own directory needs, which is a refusal and not a delete, and clears itself the moment that file is gone.

## Layer propagation stays hand-rolled (ADR 0003)

**Decided:** the scaffolding engine is not replaced by an off-the-shelf templating tool. Its one genuinely missing idea — a committed record of what the template wrote — is adopted as a small provenance file in every produced repo.

**Why:** adopting the external tool would be a rewrite of the working engine to buy one feature, it could not express the two-layer additive-plus-override model, and it would add a new runtime prerequisite for a small need. The provenance file gives precise, non-destructive updates later without a three-way merge, in a hundred dependency-free lines against a known manifest.

## Publication is by curated export (ADR 0004)

**Decided:** the working repo stays private, permanently. Publication copies an allowlisted set of paths into separate public repositories with fresh history — allowlist-first, so a path not named is not exported, and a denylist checked afterward so a future allowlist widening cannot silently include the private design and decision documents.

**Why:** the obvious alternative — flipping the working repo public — would carry its full history and issue history permanently and irreversibly, including references to several private repositories and the working notes around them. Editing before flipping does not help, because the earlier revisions are in the history being published. An allowlist that never names the private material fails closed; redaction fails open.

## A curated portfolio history and sanitized decisions (ADR 0005)

**Decided:** the export carries two additional curated documents — a development history and this sanitized decision log — and lays down fresh, phase-labeled history with its own version tags. The curated-export script is confirmed as the single authoritative publication mechanism for both public repos.

**Why:** the private design documents and decision records are the strongest evidence of process, but they name private work and cannot be published raw. Two hand-authored, private-name-free documents reclaim that evidence safely, and a per-phase commit history preserves the phased discipline that a single squashed commit would hide.

## Issues are created in one place and managed in another (ADR 0006)

**Decided:** issues are created as GitHub Issues, from the repository's own templates, and everything after creation — triage, priority, status, milestones, blocking relations, completion — happens on a separate project board. The repository's own standards document names this as a permitted variant of its default, which is that boards live with the issues.

**Why:** the work is phased and has real dependencies, and ordering that lives only as prose in issue bodies is ordering nobody can see. The same person moves between several repositories that consume this one's standards, and a board spanning them is worth more than a board inside each. The reason creation stays with GitHub rather than moving too is a limit of the integration rather than a preference: creation syncs in only one direction for one repository on the plan in use, and another repository already holds that slot — so building on it would produce a process that works in exactly one place. Creating in GitHub sidesteps the limited feature entirely and gives every repository the same shape. Revisit if the integration stops constraining creation to a single repository, or if the second tool stops earning the switch.

**A consequence worth stating plainly for anyone reading the code:** the two systems number issues independently, and the offset between them is not constant. An identifier in one is never computed from the other; both are written out wherever a human reads them.

## Templates ship through the layer, not an account-wide defaults repository (ADR 0007)

**Decided:** the issue and pull-request templates every scaffolded repository receives continue to arrive through the scaffolding layer. No account-level defaults repository is created.

**Why:** three reasons, in the order that decided it. The saving lands on the wrong files — of the five files shipped under `.github/`, the mechanism can carry three, and the two it cannot are the two that change and must be reviewed when they change. Distribution is already solved and solved better: the layer plus the provenance manifest gives every shipped file a recorded digest, propagates changes, and refuses to overwrite a copy the consuming repository has edited, naming what it skipped and why — account defaults have no provenance, no digest and no refusal. And it would create a second distribution mechanism split along a line this project does not control: the boundary would be the hosting platform's supported-file list, which has already changed once, so every future file added would need a routing decision that today does not exist.

This ADR records a rejected alternative rather than a change, so that the question costs a read rather than a rediscovery. Revisit if the supported-file list grows to cover the workflow and dependency configuration too.

## What an agent may do unattended (ADR 0008)

**Decided:** ten rules bounding what an automated agent is permitted to do without a human watching, and two conditions that must both be met before any such agent may be switched on at all. The rules cover the permission mode it runs under, the working directory boundary it may not widen, what it may publish, and what it must record about its own run. Switching one on stays an explicit act by the person whose machine it is — never a side effect of building or testing the machinery.

**Why:** the interesting half is the enablement gate rather than the rules. Machinery that is built, tested and merged looks finished, and "finished" reads as "on" to the next person who meets it. Separating the two — the code may land; the switch is a decision somebody makes on purpose, with the conditions in front of them — is what stops capability from becoming permission by default. The conditions are recorded as data rather than prose, so that a refusal quotes them rather than somebody's summary of them, and so that closing one is an edit a reviewer sees.

Revisit only through a superseding record. The ADR names its own three triggers for that, and being inconvenient is not among them.

## Routing between skills is tested with the harness that ships (ADR 0009)

**Decided:** the question of whether the right skill is chosen — as opposed to whether a named one resolves — is tested with the evaluation harness the tooling already ships, one case per confusable pair. Those cases are deliberately not part of the ordinary test suite.

**Why:** two claims justified building something bespoke and both turned out to be wrong, which is the finding. A static check can prove every routing entry resolves; it cannot see which skill a model actually picks from twenty-odd competing descriptions, and no combination of the shipped graders asserts *which* one fired — measured, not assumed, against a two-skill probe. So the choice was between a bespoke runner and accepting what the harness can do. The harness won on maintenance: a runner would need its own model access, its own scoring and its own upkeep to answer a question asked before a description changes.

They stay out of the ordinary suite because that suite is offline, dependency-free and finishes in about ninety seconds, while these call a model per case, cost money and need a network. Merging them would make the fast suite slow and the cheap suite expensive, and the usual answer to that is to stop running it.

## The defect hunt has no unattended driver, and the cost that says so (ADR 0010)

**Decided:** no unattended driver is built for the automated defect hunt. It stays something a person starts, and it reports rather than files.

**Why:** the reason is not the token bill, which this record explicitly retracts as a justification — that figure had been repeated through several documents and nobody had ever priced it. What decides it is three costs the token figure does not contain and one blocker no amount of code removes. Triage is human, recurring, and had never been counted: three report-only runs produced fifty-nine findings, of which five became durable issues, and a schedule multiplies the reading rather than reducing it. A driver could not file anyway, because filing is gated on per-lens precision figures that do not exist — so it would buy a report on a schedule rather than issues on a schedule. And a run cannot honestly report its own cost, because a lens may delegate work of its own that the tooling does not total.

The blocker is that a driver built today could not run: the enablement gate above is open, so the code would be unverifiable by construction. The record names its own reversal conditions rather than claiming permanence — precision figures that let a lens file, the enablement condition being met, and tooling that reports delegated cost — and the first two are both necessary.

## What discharges the second enablement condition (ADR 0011)

**Decided:** the second of ADR 0008's two enablement conditions is read against the specific rule it exists to enforce, rather than against the broadest reading of its own sentence. Measured, that rule asks the ambient credential to drop every permission the workflow does not use *that its issuer will let go of* — which turned out to be one command and a record, not the credential migration the sentence had been read to require.

**Why:** the sentence had three readings and none had been chosen, and the vagueness cost a whole session costing out a replacement credential for every repository on the machine. Narrowing it to the rule it enforces made the outstanding act small and reversible. The migration was declined on costs that are properties of this machine rather than of the idea, and those are recorded so the decision can be re-taken elsewhere on its merits.

The half worth reading is what the record explicitly does *not* claim. The ambient credential still carries broad permissions and every attended session reaches it. A deny rule added alongside is defence in depth and never a boundary — the same publication is reachable by several other routes, and the record says so where the code lands rather than leaving a reader to assume otherwise. And the isolation asymmetry named in that record has since been closed: both mechanisms the argument rests on are now verified by a live call on every run. Nothing in this record switches anything on.

## Writing about a closing footer (ADR 0012)

**Decided:** a closing keyword — `Fixes`, `Closes`, `Resolves` and their other tenses — is never written next to an issue number except as a real footer. To discuss one, the two halves are broken apart and joined by an explicit `+`, or the issue is named alone and the keyword described in words. The standards document gains the clause; the launch-pad validator enforces it on the one surface that is a file in a repository.

**Why:** the hosting platform's auto-close parser strips markdown before it matches, so a keyword inside a code span, inside a block quote, or under a negation still closes the issue. The convention that had been in force — *check what the footer would close* — is therefore a convention that springs its own trap, and it did so twice here. The second time, a documentation-only change closed a human-only task that blocked a deployment, through a sentence written as a **warning** about that exact hazard; the tracker recorded it as completed although no person closed it, and a staleness sweep then removed the roadmap row that depended on it.

Three properties make it worse than an ordinary mistake, and together they are the argument for a written rule rather than more care. It is silent: no continuous-integration signal, no review comment, no diff — the issue simply stops being open. It is invisible at review, because the rendered body shows the reader a code span rather than a footer. And it selects for the work that can least afford it, since nobody writes carefully about a footer unless there is a reason to be careful.

The enforcement is deliberately partial and is recorded as partial. The clause reaches seven surfaces — pull-request bodies, review comments, issue bodies and comments, handoff notes, session prompts, status reports and commit bodies — and only one of them is a file in a repository, which is the launch pad both recorded occurrences came through. A check over the other six would either miss the browser entirely or read as total while covering a fraction, which is the failure the standards document already has a section for. Within that one file the rule refuses formatting that every neighbouring rule honours, because the parser's behaviour inside a fenced block was never measured and the pathway is a copy into a body where the fence does not survive anyway: unmeasured is treated as unsafe when the failure leaves no trace.

The record carries its own falsifier. The parser behaviour was observed directly rather than read from documentation, so if the platform ever exempts code spans or quoting, the clause narrows to unformatted prose and the check narrows with it.

## The permission mode's grant survives a premise that stopped being true (ADR 0013)

**Decided:** the two rules fixing what permission mode an unattended run uses and what part of the filesystem it may touch both stand unchanged, and no superseding record is written. What was measured false is a sentence explaining the consequence of those rules, not the rules themselves; the correction is recorded here rather than by editing the immutable record that carries it.

**Why:** the earlier decision was taken against a release in which the assistant's edit-accepting permission mode also accepted shell commands automatically, and it said so in terms — a run inside its working directory therefore still reached the network, the remote and the credential store. A later release does not: shell commands that change anything are refused, and with no human present to approve one, a run fails closed. That was found by five real runs producing complete work and being unable to commit a line of it, not by a probe going looking.

The earlier record names three circumstances that would justify replacing it, and one of them is a measured **escape** from that permission mode. This is the opposite: the mode reaches less than the record believed, not more. A trigger that fires when a control weakens cannot be read to fire when it tightens. The grant itself — that mode, and never the two flags that switch permissions off — is unchanged and still enforced, and the argument for it turned on the mode being able to write, which it still can. The gap did narrow, and the narrowing is recorded rather than smoothed over: a fixer that cannot commit is no more useful than one that cannot write, and closing that took a run-scoped allowance for two version-control commands inside the run's own workspace.

Two things are stated so they cannot be inferred instead. A stricter mode is **not** licence to relax the working-directory boundary — file edits are still accepted automatically, that boundary was never containment, and the credential store is still readable by anything running as this user. And the allowance that restores committing is a match on how a command is typed, not a boundary: the same command spelled to run somewhere else does not match it. That is the same limit, in the same words, as the publication denial rule this project already refuses to call containment.

The record carries its own falsifier, because the decision rests on the direction of a change. A release restoring automatic shell acceptance would put the original sentence back into force and would be the escape trigger the earlier record names — which is a replacement, not another narrowing.
