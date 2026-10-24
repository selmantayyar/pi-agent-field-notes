# flight-recorder

A [pi](https://github.com/earendil-works/pi) extension that records every agent
turn to a JSONL file: what the model saw, what it said, what it tried to run, and what it
cost. All the numbers in [`../FINDINGS.md`](../FINDINGS.md) come from these logs.

## Install

Copy it into pi's extensions folder. pi loads it automatically on the next start:

```sh
cp flight-recorder.ts ~/.pi/agent/extensions/
```

Or load it for a single session:

```sh
pi -e ./flight-recorder.ts
```

## Output

One file per session, in `~/.pi/agent/flight-recorder/<start-timestamp>_<session-uuid>.jsonl`.
The file is appended to after every turn, so a crashed or killed session still leaves a
readable log.

There are two record types:

- **`session_header`**: the system prompt and the tool schemas. It is written once, then
  again only when either one changes. They used to be repeated on every turn and took up
  ~93% of the file.
- **`turn`**: one record per model turn. The fields that matter most:

| Field | What it tells you |
|---|---|
| `runIndex`, `turnIndex` | Together with `sessionId`, a unique key (a new user request restarts `turnIndex`) |
| `model`, `thinkingLevel` | What actually ran, so comparisons are like for like |
| `systemPromptSha`, `toolSchemasSha` | Detects a prompt or tool set that changed between runs |
| `toolCalls` | Every call the model made, including malformed ones flagged `rejectedPreDispatch` |
| `tokenSplit` | `input`, `output`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cacheHitRate`, `contextTokens` |
| `rawUsage` | The provider's usage object verbatim, including `cost` |
| `stopReason` | Separates a normal stop from a length cutoff or a provider error |
| `modelReasoning`, `modelText` | Thinking and output text, capped at 20k chars (`*Chars` holds the real length) |
| `toolResults` | What the tools returned |
| `latencyMs` | Wall-clock time for the turn |
| `incomplete` | `true` if the turn started but never finished (abort, crash, restart) |

Missing values are `null`, never `0`, so "the provider didn't report it" can't be mistaken
for "it was zero".

## Commands

Inside pi:

- `/flight-recorder` shows the current session's log path.
- `/flight-recorder json [path]` converts a log (this session's by default) to a
  pretty-printed JSON array next to the original and copies it to the clipboard.

## Quick analysis

```sh
# turns, tool calls and total cost for a session
jq -s '[.[] | select(.type=="turn")] |
  {turns: length,
   toolCalls: (map(.toolCalls | length) | add),
   rejected: (map(.toolCalls[] | select(.rejectedPreDispatch)) | length),
   cost: (map(.rawUsage.cost.total // 0) | add)}' session.jsonl
```

## Limitations

- Tool calls are attached to the most recently started turn, which assumes one turn runs
  at a time.
- Logs contain full prompts, file contents and command output from the session. Review them
  before sharing.
