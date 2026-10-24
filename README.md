# agent_pi_eval

Can a small or local model do real engineering work inside the
[pi](https://github.com/earendil-works/pi) coding agent, and what does the
harness need before you can trust the answer?

This repo has the write-up, the raw session logs it is based on, and the pi extension that
recorded them.

## Headline

A **local Qwen3.8-27B** on an M4 MacBook Pro did the best work of any run, including the
hosted GLM 5.2. It was the only model that actually tested the change end to end, and it
caught its own false positive. It also took 10× longer.
A **free routed OpenRouter model** broke the repo *and* the host's Python environment, and
then reported success.

Read the full write-up in **[FINDINGS.md](FINDINGS.md)**.

## Contents

| Path | What |
|---|---|
| [`FINDINGS.md`](FINDINGS.md) | Three experiments, model recommendations, and what pi needs |
| [`flight-recorder/`](flight-recorder/) | pi extension that logs every turn to JSONL ([docs](flight-recorder/README.md)) |
| [`sessions/`](sessions/) | Raw flight-recorder logs from the runs |

### Sessions

The task in every run: convert the assistant's FastAPI `/ask` endpoint from sync to async
(see [the assignment](FINDINGS.md#the-assignment)).

| File | Model | Date |
|---|---|---|
| `pi_openrouter_free_base_skills.jsonl` | OpenRouter free tier | 2026-08-17 |
| `pi_glm_base_skills.jsonl` | GLM 5.2 | 2026-08-17 |
| `pi_openrouter_free_base_skills_fixed.jsonl` | OpenRouter free tier | 2026-08-18 |
| `pi_glm_base_skills_fixed.jsonl` | GLM 5.2 | 2026-08-18 |
| `pi_qwn38_base_skills_fixed_2.jsonl` | Qwen3.8-27B (local) | 2026-08-20 |
| `pi_qwn38_base_skills_fixed_1.jsonl` | Qwen3.8-27B (local) | 2026-08-20 |

The `_fixed` runs were recorded after the recorder and harness fixes described in
FINDINGS.md, and they are the ones the comparison numbers come from. The earlier runs are kept
for reference.

The company's name has been replaced in the logs, so the `systemPromptSha` values (hashed
from the original prompts) won't match the prompt text stored in the files.

## Reproduce

1. Install the recorder: `cp flight-recorder/flight-recorder.ts ~/.pi/agent/extensions/`
2. Run pi on your task with each model. Reset the repo **and** any untracked instruction
   files (`CLAUDE.md`, `AGENTS.md`) between runs, and pin the thinking level.
3. Logs land in `~/.pi/agent/flight-recorder/`.

## License

MIT
