#!/usr/bin/env node
// The three-archetype panel. Three Codex agents argue a topic with each other
// and with the Claude agent, which chairs.
//
// codex exec on this machine CANNOT read files (its read-only sandbox fails
// with CreateProcessAsUserW: Access is denied) and CANNOT take a large prompt
// as an argument (Argument list too long). Everything goes in via stdin:
//   codex exec - < prompt.txt
// Verified 2026-07-22. Do not "fix" this back to -C or a positional prompt.
import { runCli } from './lib/cli.mjs';

// Mid-tier by default. A max or ultra-high model is only ever used when the
// user has explicitly asked for it; the chair may ask, but never assumes.
// The bare names ("terra") are rejected by codex exec — pass the full id via
// -m plus -c 'model_reasoning_effort="medium"'. Ids follow the naming in
// ~/.codex/config.toml (verified 2026-07-24 on codex-cli 0.145: gpt-5.6-*);
// when codex bumps the version, read the config for the current family.
export const DEFAULT_MODELS = {
  native: { model: 'gpt-5.6-terra', effort: 'medium' },
  veteran: { model: 'gpt-5.6-terra', effort: 'medium' },
  aesthete: { model: 'gpt-5.6-sol', effort: 'medium' },
};

export const ARCHETYPES = [
  {
    id: 'native',
    title: 'The native',
    stance: 'this codebase is the law',
    prompt: [
      'You argue from THIS codebase and nothing else. Its CLAUDE.md, its',
      'engineering-standards, its ADRs, its established idiom and its stated user',
      'preferences are the law. A proposal that is elegant in the abstract but',
      'foreign here is wrong here. Cite the specific rule, file or convention behind',
      'every point you make; an argument you cannot ground in this repo is one you',
      'do not get to make.',
      'You are strong-willed. Hold your position under pressure and make the others',
      'answer your evidence rather than talk past it. Concede only to a concrete',
      'argument, never to consensus or to seniority.',
    ].join(' '),
  },
  {
    id: 'veteran',
    title: 'The veteran',
    stance: 'what works everywhere, and still works later',
    prompt: [
      'You have worked across many codebases, languages and eras. You argue for what',
      'works generally and keeps working: boring technology, reversible decisions,',
      'small blast radius, designs that a tired person can still operate in two',
      'years. You weight the future more heavily than the present and you are deeply',
      'suspicious of anything clever, bespoke, or justified only by local habit.',
      'You are strong-willed. Hold your position under pressure. Name the specific',
      'failure you have seen this pattern cause before. Concede only to a concrete',
      'argument, never to consensus or to local convention.',
    ].join(' '),
  },
  {
    id: 'aesthete',
    title: 'The aesthete',
    stance: 'the best possible experience for the most people',
    prompt: [
      'You are a high-level designer and you are compulsive about it. You argue for',
      'whatever produces the most pleasing, coherent, comprehensible result for the',
      'largest possible group of users, and you do not care what it costs to build.',
      'Cost, scope and schedule are somebody else\'s problem; your job is to make sure',
      'nobody in this room settles for something ugly, confusing or half-finished',
      'because it was easier.',
      'You are strong-willed. Hold your position under pressure. Describe concretely',
      'what the user sees and feels under each option. Concede only to a concrete',
      'argument, never to an appeal to effort.',
    ].join(' '),
  },
];

export function buildPrompt(archetype, { topic, round, others }) {
  const lines = [
    'You are one of three reviewers deliberating a decision. Do not be agreeable.',
    'Do not summarize the others. Argue.',
    '',
    `YOUR ROLE: ${archetype.title} — ${archetype.stance}.`,
    archetype.prompt,
    '',
    `This is round ${round}.`,
  ];

  if (others.length) {
    lines.push('', 'Here is what the others argued. Engage their strongest point directly,',
      'by name, and say where they are wrong and why:', '', ...others);
  }

  lines.push('', 'THE TOPIC:', '', topic, '',
    'Be terse. No preamble, no compliments. Lead with your position, then your',
    'reasoning, then the single strongest objection you expect and your answer to it.');

  return lines.join('\n');
}

export const DEFAULT_MAX_ROUNDS = 3;

const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

export function isLooping(history) {
  if (history.length < 2) return false;
  const [prev, last] = history.slice(-2);
  return same(prev.positions, last.positions);
}

export function nextAction(history, opts = {}) {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (isLooping(history)) {
    return { action: 'halt', reason: 'positions repeated verbatim — the panel is looping, stop paying for rounds' };
  }
  if (history.length >= maxRounds) {
    return { action: 'resolve', reason: `reached ${maxRounds} rounds — the chair calls it` };
  }
  return { action: 'continue', reason: 'positions are still moving' };
}

export { runCli };
