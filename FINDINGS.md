# Running coding agents on pi — what we learned

Notes from three experiments with the `pi` coding agent, August 2026. Written to be read
by an agent picking up this work, or by a human deciding what to run next.

Two questions were being asked:

1. **Can a small/local model do real engineering work?**
2. **What does the pi harness need before the answer to (1) is trustworthy?**

---

## The assignment

All three experiments use the same codebase: a take-home assignment for an AI engineering
role. In short, the brief asks for:

- **A customer-support assistant** for a telecom provider that answers questions about its
  internet and TV products, grounded in the provider's own website.
- **A small RAG pipeline**: scrape a product page, strip the boilerplate, chunk the text,
  embed it, and store it in a local vector store (Chroma, OpenSearch or similar). The
  embedding model and store choices have to be justified on quality, cost, latency and
  ease of use.
- **An agentic backend in LangGraph**: take the question, retrieve context, call an LLM with
  tone and safety instructions, and return a customer-ready answer. Weak or empty retrieval
  has to be handled, either with an explicit "can't answer from this content" or another
  path through the graph such as reformulating the query.
- **A FastAPI service** with a `POST /ask` endpoint, packaged with a Dockerfile and
  docker-compose, that answers end to end after `docker compose up`.
- **Documentation**: a README covering the model choices and the graph design, plus
  architecture diagrams for the local setup and a sketch of an AWS deployment (scaling and
  security).

It was scoped as a 3–5 hour exercise. That makes it a good test: small enough to finish in
one session, but with real design decisions (where the vector store lives, how ingestion
runs, what to do with a bad retrieval) on top of the coding.

The company is not named. In the session logs it has been replaced with "Telco", and its
domain with `telco.example`.

---

## Experiment 1 — build the whole thing from scratch

**Task:** implement the assignment above end to end.
**Model:** Muse Glimmer (local).
**Compared against:** the same assignment built with Claude Code on Fable 5.0
(`telco-support-agent`).

The pi version worked, but made choices that cost real time:

| What it did | Why it hurt | Better choice |
|---|---|---|
| Ran Chroma as a Docker service | Every dev cycle waits for Chroma to boot | In-process Chroma for dev, OpenSearch for prod |
| No ingestion-on-startup | Had to discover a one-off `docker-compose` run to populate the index | Check whether the local Chroma file exists at boot, ingest if not |
| Never documented the API key | Nobody can run it from a clean checkout | Document required env vars |
| No Docker build cache | Every rebuild took several minutes | Layer the Dockerfile so deps cache |
| Plain RAG, no correction step | Loses the grading / reformulate / fallback loop the assignment wanted | Design corrective RAG up front |

**Read:** these are all *design* misses, not coding misses. The model wrote working code and
made poor architecture calls. That gap is what skills and up-front planning are for — none
were used.

---

## Experiment 2 — same repo, one code change, two hosted models

**Task:** *"The `/ask` endpoint is `def`, not `async def`. Make the flow use the event loop
instead of sync handlers in a threadpool."*

**Models:** OpenRouter free tier (routed, identity unknown) vs GLM 5.2.

### The free model broke the machine

It hit a `ModuleNotFoundError` — caused entirely by its own choice to call bare `python`
instead of the project's virtual environment. Its fix was to run `pip install -e .`, which
resolved to the **base conda environment** and upgraded 14 packages there. `pip check` now
reports broken dependencies for `litellm`, `pdfr`, `traceloop-sdk` and two OpenTelemetry
packages.

**A self-inflicted problem, solved by damaging the environment around it.** GLM used
`uv run` throughout and never encountered the problem at all.

### Everything else

| | Free model | GLM 5.2 |
|---|---|---|
| Result | Broken — repo wouldn't even import | All tests pass |
| Tool errors | 13 of 43 | 0 of 36 |
| Input tokens | 23× GLM's | baseline |
| Reasoning volume | 2.7× GLM's | baseline |
| Asked a clarifying question | Never | Yes |
| Cost | $0 | $0.45 |

Notable failures:

- **A path it never learned.** It wrote `telco_support_agent` (underscore) instead of
  `telco-support-agent` (hyphen) **six separate times** — including once immediately after a
  `find` command returned the correct path. It could not update its own beliefs from tool output.
- **Reasoning that went nowhere.** Its longest single deliberation — 10,717 characters over
  two minutes — ended in an edit to a path that doesn't exist.
- **It reported success it hadn't achieved**, and when its own test run failed, wrote generic
  troubleshooting advice *for the user* instead of fixing anything.

### The standout difference

GLM stopped and **asked a question** before writing code: the app's vector store has no async
API, so should it be wrapped in a thread, moved to a server, or left alone? Three options with
the tradeoffs spelled out. It then built what was chosen and said so in its summary.

Recognising which decisions aren't yours to make is the clearest quality signal in any of
this data.

### "Free" is not free

Derived rates: **$1.40 per million input tokens, $4.40 output, $0.26 for cached input.**
The free model burned 23× the input tokens for a broken result — roughly **3.7× more in
tokens than the paid model cost in money**.

**Verdict: don't evaluate with a free routed tier.** Use a local model or a paid one.

---

## Experiment 3 — same task, local model vs hosted

**Models:** Qwen3.8-27B running locally on an M4 MacBook Pro, vs GLM 5.2.

**The local model produced the best work of any run — including GLM's.**

It was the only model across all three experiments that **actually tested the thing the task
was about**: it started the server and fired three simultaneous requests, which completed in
~3.5 seconds each against a ~3.1 second single-request baseline. That is real proof the
change worked, not an assertion that it did.

It also caught its own false positive. Its first test run looked suspiciously fast and
returned a response with the wrong shape. It investigated, found a **stale Docker container
still holding port 8000 and serving the old code**, moved to a different port, re-tested, and
flagged the container for cleanup.

Noticing that a passing test passed for the wrong reason is the highest-quality behaviour in
this entire dataset.

Other differences from GLM:

- Fixed the type-checker error instead of only proving it pre-existing
- Replaced the blocking HTTP library with an async one rather than wrapping it in a thread
- Wrote an architecture decision record
- **Batched its tool calls** (1.33 per turn vs GLM's 0.97) — the only model that followed the
  harness's own instruction to do so
- Used **fewer input tokens than GLM** (local caching hit 98.4%)

Costs: **10× the wall-clock time** (79 minutes vs 7), and it made an architectural decision
unilaterally where GLM asked.

---

## Picking a model

| Situation | Use |
|---|---|
| Time matters, budget is fine | **GLM 5.2** — 10× faster, near-zero tool errors, knows when to ask |
| Quality matters more than speed | **Local Qwen3.8-27B** — best artifact produced, verifies end to end, free |
| Evaluating the harness | **Never a free routed tier** — you measure routing noise, not capability |

A local 27B model doing better work than a hosted frontier model is the headline finding.
It is not a compromise choice.

---

## What pi needs

Ranked by how much each one cost us.

### 1. A guard on dangerous commands

`pip install` into a global environment, `git push`, `rm -rf` — these should require
confirmation. pi's `tool_call` hook already supports blocking (`{ block: true, reason }`); a
short deny-list would have prevented the environment damage in Experiment 2.

**Instructions in `CLAUDE.md` are not a guard.** The file already said "never run
`git commit` / `git push`" — that is prose a model may ignore, not something the harness
enforces.

### 2. Snapshot the instruction files between runs

An agent edited `CLAUDE.md` during one run. Because `CLAUDE.md` and `docs/` are deliberately
untracked by git, `git checkout` did **not** restore them — so the *next* run started with a
system prompt describing the finished state of the task before it began.

Any reset procedure has to cover untracked instruction files, not just tracked code.

### 3. Rules in the prompt are not a correctness gate

An `AGENTS.md` rule saying "run the tests before reporting done" **improved** behaviour — the
free model did run the tests — but did not change the outcome. It saw them fail and wrote
advice instead of a fix.

If correctness matters, check it outside the model: run the tests yourself after the agent
finishes and record the exit code.

### 4. Recover from rate limits

Four consecutive provider errors ended a session with the repository in a broken state. Some
form of checkpointing and retry would let a run survive that.

### 5. Skills don't fire on their own

Seventeen skills were visible to the model across these runs. **Zero were used.** pi's own
documentation concedes this: models don't reliably load a skill file just because its
description matches.

For repeatable results, invoke skills explicitly with `/skill:name` rather than hoping.

---

## Correction: the tree-sitter mystery

**The tree-sitter / LSP capability was never missing, and it isn't a skill.**

It ships as the `@mrclrchtr/supi-code-intelligence` package, which provides eight tools:
`code_find`, `code_graph`, `code_orientation`, `code_resolve`, `code_inspect`, `code_health`,
`code_refactor_plan`, `code_refactor_apply`. There are no tree-sitter *skills* installed
anywhere — searching `~/.agents/skills/` and `~/.pi/agent/skills/` finds nothing.

The reason it never activated when searching for a function is the tool-list bug, not skill
discovery:

- pi's system prompt contains a **hand-written list of tools that doesn't match the tools
  actually loaded**. Any tool from an installed package is invisible in it.
- Worse, the prompt then says *"Use bash for file operations like ls, grep, find"* — actively
  steering the model away from the dedicated tools.

**This is already fixed.** An extension now regenerates the list from the live tool set at the
start of every turn, and `code_orientation` was called for the first time in the very next
experiment. Nothing further is needed here.

---

## Setup notes

Useful, in rough order of value:

- **Flight recorder** — every session is recorded to `~/.pi/agent/flight-recorder/`. All the
  numbers in this document come from those files. Sessions also export to HTML, which gives
  very readable turn-by-turn visibility.
- **Full wire logging** — `pi -e ~/.pi/agent/ext-optional/wire-log.ts` captures complete
  request/response payloads when the recorder isn't detailed enough.
- **Trim the tool list** — `pi -t read,bash,edit,write,grep,find,ls` cuts most of the tool
  definitions out of every request. The seven tools that do the actual work are only about a
  tenth of the payload. Matters a lot on providers without caching; barely at all on providers
  with it.
- **pi can extend itself** — per its author, you can ask pi to write its own extensions. The
  tool-list fix above was built this way.

### What the recorder tracks, and why each field earns its place

After several rounds of fixes, these are the fields that actually changed a conclusion:

| Field | What it caught |
|---|---|
| `stopReason` | Rate-limit failures and output-length cutoffs, instantly distinguishable from a model choosing to stop |
| `cacheHitRate` | Explains most token-cost differences between models — was structurally broken and always empty before |
| `cost` | Real money per run, instead of estimates |
| `rejectedPreDispatch` | Tool calls the model *tried* to make that were malformed — previously invisible, and exactly where the interesting failures are |
| `modelReasoningChars` | Reasoning volume when the provider doesn't report reasoning tokens (local models don't) |
| `systemPromptSha` | Caught the `CLAUDE.md` contamination described above — otherwise undetectable |

---

## Running a fair comparison

Mistakes made and worth not repeating:

1. **Reset the repo between runs.** Two comparisons were invalidated because one model started
   from a tree the previous model had already modified.
2. **Reset untracked instruction files too** (see #2 above).
3. **Pin the thinking level.** One comparison had it on for one model and off for the other.
4. **Check correctness outside the model.** Run the tests yourself; record pass/fail.
5. **Two cheap signals separate good runs from bad ones**, with no ground truth needed:
   *did it run the tests?* and *did it claim success?* A run that claims success without
   running anything is the failure pattern worth catching automatically.
