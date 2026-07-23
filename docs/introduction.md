# What daftplate Is, and Why It Exists

## The problem: an assistant that runs out of room

I build software mostly by working alongside an AI assistant, one project at a time — sometimes a personal finance tool, sometimes a small game backend, sometimes a marketing site. That way of working is fast, but it has a specific failure mode: the assistant can only hold so much information in its head at once. Ask it to read too many files, track too many decisions, or juggle too many moving parts in a single stretch of work, and its grip on the project starts to slip. It forgets earlier choices, contradicts itself, or quietly does the wrong thing with total confidence.

I call this running out of room. It is not the assistant being careless — it is a hard limit on how much any one conversation can hold, and every project eventually grows past it. Left unmanaged, that limit shows up as wasted work: the assistant re-solving problems it already solved, missing constraints stated three files ago, or producing something that looks right but does not fit.

The fix is not a smarter assistant. It is a better way of handing it work: keep each task small enough to finish inside a single clear stretch of attention, and make sure the assistant starts every one of those stretches already oriented, instead of reading its way back into the project from scratch.

## The system: one source of truth, three jobs

daftplate is the project that makes that fix systematic instead of something I have to remember to do by hand. It does three things.

First, it is a stamping press for new projects. When I start something new, daftplate builds the first version of that project's repository from a set of templates — the standard files, folders, and setup every project should start with — so I am never assembling the basics from memory and never starting a project slightly wrong.

Second, it ships a set of reusable playbooks for the assistant — short, focused instructions for a specific recurring job, like reviewing a change, planning a phase of work, or getting oriented at the start of a session. Instead of re-explaining how I want something done every time, I point the assistant at the right playbook and it already knows the drill.

Third, and most important, it enforces a discipline around the "running out of room" problem directly: every piece of work has to be broken into phases small enough that one of them comfortably fits in a single working session, with a short list of exactly what needs to be read before that phase starts. No phase gets to sprawl until the assistant is drowning in it.

## The outcome: consistent projects, an assistant that stays sharp

The payoff shows up twice. Every new project starts from the same solid, correct foundation instead of an improvised one, so early mistakes stop repeating themselves across projects. And because work is planned in bite-sized pieces with a clear starting point, the assistant stays oriented through long stretches of work instead of gradually losing the thread.

There's a second benefit worth naming: daftplate holds itself to its own rules. It plans its own work in the same small, disciplined phases it prescribes for everything else, and it verifies its own output automatically rather than taking it on faith. That makes the project not just a tool I use, but a working example of disciplined, AI-assisted engineering — evidence of how I actually build things, not just a claim about it.
