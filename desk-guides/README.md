# Desk guides

Six one-page printable references for the cork board. Print them, pin them, read
them from across the room.

| File | Page | What it answers |
|---|---|---|
| `a1-claude-skill-card` | A1 | Which Claude skill do I invoke, and when? |
| `a2-codex-skill-card` | A2 | What can Codex actually do here right now? |
| `b-coding-workflow` | B | What is the loop, and which path does this task take? |
| `c-profile-map` | C | What does each profile change about the default path? |
| `d-ship-release-publish` | D | What must happen before and after a release? |
| `e-work-and-decisions-map` | E | Where does this artefact belong? |
| `desk-guides` | all six | The convenience bundle, in A1 A2 B C D E order |

## Generating them

```
npm run desk-guides
```

That is the whole interface. It inventories this repository, your installed
Claude skills and your installed Codex plugins; applies the editorial policy in
`desk-guides.config.json`; generates six HTML pages and a combined bundle;
measures every page in a real browser; prints each one to PDF; reopens every PDF
with `pdfinfo`; renders a PNG preview of each; and only then replaces the
previous output set.

Options:

```
node scripts/build-desk-guides.mjs
  [--out <directory>]        where the validated set is promoted
  [--tool claude|codex|all]  limit skill-card generation; B-E always build
  [--claude-skills <dir>]    installed Claude skill root
  [--codex-skills <dir>]     personal Codex skill root
  [--html-only]              stop before PDF
  [--check]                  build and validate, promote nothing
  [--verbose]                report each stage
```

Exit 0 means every guide is valid. Exit 1 means source, configuration, layout or
render validation failed. Exit 2 means invalid usage or a missing local tool.

**`--html-only` means "stop before PDF", not "skip validation".** It still needs a
browser, because a page nobody measured is a page that prints wrong — which is the
state this generator replaced. Use it when Poppler is absent: the staged HTML is
retained, and you can open and print it from the browser yourself.

**`--check` promotes nothing.** It answers "would the committed configuration and
the current sources produce a clean set today?" and leaves the last good output
exactly as it was.

## Prerequisites

Two, and they are prerequisites of this command and nothing else. They are
deliberately absent from `scripts/check-machine.mjs` — see `docs/setup-guide.md`.

- **A Chromium-family browser.** Edge is preferred, Chrome is the fallback. Used
  to measure real page geometry and to print HTML to PDF.
- **Poppler**, for `pdfinfo` and `pdftoppm`. Install with `winget install
  oschwartz10612.Poppler` on Windows, `brew install poppler` on macOS, or
  `sudo apt install poppler-utils` on Linux. Reopen the shell afterwards on
  Windows so the new `PATH` is picked up.

The generator probes for both and refuses with the install command when either is
missing. It never installs anything, and it never reaches the network.

## What it produces

Everything lands in `output/pdf/desk-guides/`, which is gitignored:

- six `*.html` pages and `desk-guides.html`, self-contained and printable;
- six `*.pdf` files, each exactly one Letter-landscape page;
- `desk-guides.pdf`, exactly six pages, in A1 A2 B C D E order;
- six `*.png` previews at the configured DPI, for visual inspection;
- `inventory.json` — every discovery and why it was shown, grouped or omitted;
- `manifest.json` — the ownership record: every generated file, its digest, page
  counts and dimensions, tool versions, and the source commit.

## The six hand-written pages in this directory

`a1-claude-skill-card.html` through `e-work-and-decisions-map.html` here are the
**original hand-maintained set**, and they are still the ones that have been
printed and pinned. They are retained deliberately, not left behind: nothing in
the generator's four implementation phases authorizes deleting files it did not
create, and the generated set has not yet passed physical print acceptance.

Whether they become generated outputs, stay as reference fixtures, or are removed
is one explicit decision to make after that print — in its own reviewed change.
Until then, treat these as the record of the content model the generator
reproduces, and treat `output/pdf/desk-guides/` as the live set.

## Source and generated

**Edit `desk-guides.config.json`. Never edit the generated HTML** — the next run
overwrites it, and the page footer says so.

The configuration is editorial policy: what is worth printing, in what order,
under which heading, in how many words. It is not a copy of the sources. An entry
carrying a discovered fact — a source path, a frontmatter description, a
profile's `verify` command — is a hard error, because a configuration that
shadows its sources is how they drift apart unnoticed.

Discovery owns what exists. Configuration owns what prints. Neither owns both.

## When it refuses

The strictness is the feature. This whole generator exists because the previous
hand-maintained pages went stale silently, so almost everything fails loudly
instead:

- a configured key discovery cannot find;
- a duplicate canonical key from two source paths, naming both;
- a new `profiles/<type>/` with no summary in the configuration;
- an omission with no reason;
- a Codex plugin that is installed but disabled, or available but not installed,
  printed as active;
- any page that overflows, drops below the type contract, exceeds its line
  budget, is occluded by an opaque neighbour, or shares a rectangle with other
  text;
- a PDF that is not exactly one Letter-landscape page, or a bundle that is not
  exactly six;
- an output directory holding a file this generator did not write.

**A failed run never touches the previous output set.** Everything is built in a
staging directory and promoted only after the whole set validates. Verified by
failure injection: a good 22-file set stayed byte-identical across a run that
exited 1.

## Reading the inventory

`inventory.json` is the accounting document, and the reason "it fits on the page"
is never achieved by quietly dropping something. Every discovery has exactly one
disposition:

- `shown` — printed, with its page and group;
- `grouped` — absorbed into a printed family, which records every member;
- `omitted` — deliberately left off, with a reason.

To find out why something is not on a card:

```
node -e "const i=require('./output/pdf/desk-guides/inventory.json');console.log(i.entries.filter(e=>e.disposition==='omitted').map(e=>e.key+' -- '+e.reason).join('\n'))"
```

To add something, give it an entry in `desk-guides.config.json` and run again. If
the page then overflows, **cut words, not type size.** The type contract is the
acceptance criterion, not a preference.

## Printing

Open a PDF and print it. Set:

- **Layout** — Landscape
- **Paper size** — Letter
- **Scale** — 100%, not "Fit to page"
- **Margins** — None
- **Options** — Background graphics **on**

Background graphics matter: the stop bands on pages D and E are white text on a
dark fill, and they print as blank strips without them. Every page is designed to
survive grayscale, so a mono printer is fine.

## Type contract

Set by `docs/designs/2026-07-28-printable-desk-guides.md`, and it is the
acceptance criteria rather than a preference. Title 26–30pt, section heading
17–20pt, primary body 13–14pt, secondary body minimum 12pt, footer minimum 9.5pt,
line-height at least 1.18, no condensed faces. Computed style is measured in the
browser, not read from the stylesheet — an inherited `font-size: 0.8em` produces
9.6pt from a sheet whose every literal says 12pt.

## What the layout gate measures, and why each rule exists

A clean `scrollHeight`/`scrollWidth` result is **not** sufficient, and this
section is the evidence for that claim rather than an assertion of it.

- **Overflow**, on boxes that actually clip. An `overflow: visible` element whose
  content spills is not lost ink; flagging it produced a standing false positive
  on every page title, which is how a gate stops being read.
- **Line count**, from measured line boxes. Copy expected to occupy seven lines
  reached twelve, and eight cards overflowed their 145px boxes. Neither an
  estimate nor a `\n` count can see that.
- **Occlusion.** Page B's core-loop strip rendered "Orient" as "Orien" and
  "worktree" as "worktre" because opaque, negatively-margined cells painted over
  their neighbours. `scrollWidth === clientWidth` throughout.
- **Text over text.** Found by looking at a page this gate had just called clean:
  the B3 table printed across the footer's provenance line. Each box fitted its
  parent, nothing clipped, and no opaque box painted over anything — two
  transparent runs of text simply occupied one rectangle.

The last one is the standing lesson. **Look at the rendered page before you trust
a green check**, and when you find something the gate missed, give it a rule and a
fixture rather than a note.

## No skill wrapper

There is deliberately no `/desk-guides` skill. `npm run desk-guides` is
discoverable, works without an agent, and needs no cross-repository installation
assumption now that skills ship separately in daftkit. A wrapper can be specified
later if it probes for daftplate and explains the remedy when it is absent.
