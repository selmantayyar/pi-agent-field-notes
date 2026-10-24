import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

type TurnRecord = {
  runIndex: number;
  turnIndex: number;
  startTime: number;
  systemPromptSha: string;
  toolSchemasSha: string;
  model: string;
  thinkingLevel: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// The log stays JSONL on disk. It is appended to after every turn, so a
// top-level array would only become valid JSON once a closing bracket landed —
// and a session that is killed, crashes, or is still running (exactly the
// cases flushIncomplete exists for) would leave a file no parser could open.
// One line per record is also what makes an interrupted final write cost one
// record instead of the whole file. Converting on demand keeps the write path
// crash-safe and still yields something a JSON editor will take.
function jsonlToArray(sourcePath: string): { json: string; records: number; skipped: number } {
  const records: unknown[] = [];
  let skipped = 0;
  for (const line of readFileSync(sourcePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // A torn final line is expected while a session is live or after a kill.
      // Counted and reported rather than thrown: a partial log is still worth
      // reading, and silently dropping a record would be worse than saying so.
      skipped++;
    }
  }
  return { json: JSON.stringify(records, null, 2), records: records.length, skipped };
}

// Providers disagree on what they call things, so we probe several names. A
// miss returns null rather than 0: a turn where usage was absent must not be
// indistinguishable from a turn that genuinely used no tokens, because these
// values get summed.
function firstNumber(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return null;
}

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const p of content) {
    if (typeof p === "object" && p !== null && "type" in p && (p as any).type === "text" && typeof (p as any).text === "string") {
      parts.push((p as any).text);
    }
  }
  return parts;
}

// Thinking/reasoning blocks are what actually explain *why* a turn ran long or
// went sideways. Plain text is the turn's output. Both are worth keeping, but
// separately: collapsing them into one field left no way to tell which of the
// two a given record had captured.
function extractThinkingParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const p of content) {
    if (typeof p === "object" && p !== null && "type" in p) {
      const t = (p as any).type;
      if (t === "thinking" || t === "reasoning") {
        if (typeof (p as any).text === "string") parts.push((p as any).text);
        else if (typeof (p as any).thinking === "string") parts.push((p as any).thinking);
      }
    }
  }
  return parts;
}

// A tool call the model emitted, as it emitted it. The `tool_call` event fires
// only after schema validation and dispatch, so a malformed call (arguments as
// a JSON string instead of an object, say) never reaches it: the log showed an
// empty toolCalls array beside a validation error, with the arguments that
// caused it discarded. Those arguments are the whole point of the record.
// Blocked calls (a `tool_call` handler returning { block: true }) go missing
// the same way.
function extractToolCallParts(content: unknown): Array<{ id: string; name: string; arguments: unknown }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
  for (const p of content) {
    if (typeof p === "object" && p !== null && "type" in p && (p as any).type === "toolCall") {
      calls.push({ id: (p as any).id, name: (p as any).name, arguments: (p as any).arguments });
    }
  }
  return calls;
}

// Generous, because the turns worth reading are the long ones and the previous
// 2000-char cap clipped exactly those.
const CAPTURE_CAP = 20_000;

// Truncation is recorded rather than silent: a clipped field and a genuinely
// short one are otherwise indistinguishable downstream.
function capture(parts: string[]): { text: string; chars: number } | null {
  const joined = parts.join("\n").trim();
  if (!joined) return null;
  return { text: joined.slice(0, CAPTURE_CAP), chars: joined.length };
}

export default function (pi: ExtensionAPI) {
  // One id per process/session so records from different runs (e.g. an
  // unrelated flight-search session vs. an actual task run) are never
  // silently averaged together downstream.
  const sessionId = randomUUID();

  // One file per session instead of one ever-growing append log: the file
  // itself is now the session boundary, so nothing downstream has to split a
  // shared log back apart by sessionId. Naming mirrors ~/.pi/agent/sessions
  // (<start timestamp>_<uuid>.jsonl) so files sort chronologically.
  const logDir = join(
    process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
    ".pi",
    "agent",
    "flight-recorder",
  );
  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(logDir, `${startedAt}_${sessionId}.jsonl`);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  // turnIndex restarts at 0 for each new run within a session (a fresh user
  // request, or a compaction), so it is not unique on its own — 5 of 10
  // recorded sessions had duplicates, one with three separate runs. runIndex
  // increments on each restart so (sessionId, runIndex, turnIndex) is a real
  // primary key.
  let runIndex = 0;
  let lastTurnIndex: number | null = null;

  // Dedup state for the session header (systemPrompt + tool schemas are
  // rewritten verbatim every turn otherwise, ~93% of file size).
  let lastSystemPromptSha: string | null = null;
  let lastToolSchemasSha: string | null = null;

  function maybeWriteSessionHeader(systemPrompt: string, systemPromptSha: string, tools: unknown[], toolSchemasSha: string) {
    const systemPromptChanged = systemPromptSha !== lastSystemPromptSha;
    const toolSchemasChanged = toolSchemasSha !== lastToolSchemasSha;
    if (!systemPromptChanged && !toolSchemasChanged) return;

    const header = {
      type: "session_header" as const,
      sessionId,
      timestamp: new Date().toISOString(),
      systemPromptSha,
      systemPrompt: systemPromptChanged ? systemPrompt : undefined,
      toolSchemasSha,
      toolSchemas: toolSchemasChanged ? tools : undefined,
    };
    try {
      appendFileSync(logPath, JSON.stringify(header) + "\n", { encoding: "utf-8" });
    } catch {
      // Best effort logging
    }
    lastSystemPromptSha = systemPromptSha;
    lastToolSchemasSha = toolSchemasSha;
  }

  // Keyed by runIndex:turnIndex, not turnIndex alone. Keying by turnIndex
  // meant a run restart could `set` over an in-flight record, dropping that
  // turn from the log entirely; it also left the overwritten record in its
  // original insertion slot, so the "last entry" heuristic below would
  // misattribute tool calls.
  const turns = new Map<string, TurnRecord>();
  const turnKey = (run: number, turn: number) => `${run}:${turn}`;

  function writeEntry(entry: Record<string, unknown>) {
    try {
      appendFileSync(logPath, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
    } catch {
      // Best effort logging
    }
  }

  // A turn whose turn_end never fires (abort, crash) would otherwise sit in
  // the map forever and never reach disk. Flush it as incomplete instead:
  // "this turn started and we never saw it finish" is itself the interesting
  // forensic signal, and it should not look like a turn that never happened.
  function flushIncomplete() {
    for (const [key, record] of turns) {
      writeEntry({
        type: "turn",
        incomplete: true,
        sessionId,
        timestamp: new Date().toISOString(),
        runIndex: record.runIndex,
        turnIndex: record.turnIndex,
        model: record.model,
        thinkingLevel: record.thinkingLevel,
        systemPromptSha: record.systemPromptSha,
        toolSchemasSha: record.toolSchemasSha,
        toolCalls: record.toolCalls,
        tokenSplit: null,
        rawUsage: null,
        latencyMs: Date.now() - record.startTime,
        stopReason: null,
        modelReasoning: null,
        modelReasoningChars: null,
        modelText: null,
        modelTextChars: null,
        toolResults: [],
      });
      turns.delete(key);
    }
  }

  pi.on("turn_start", (event, ctx) => {
    const turnIndex = event.turnIndex;

    // A turnIndex that doesn't advance means a new run began.
    if (lastTurnIndex !== null && turnIndex <= lastTurnIndex) {
      flushIncomplete();
      runIndex++;
    }
    lastTurnIndex = turnIndex;

    const systemPrompt = ctx.getSystemPrompt?.() ?? "";
    // ToolInfo is Pick<ToolDefinition, name|description|parameters|
    // promptGuidelines> & { sourceInfo }. `label` and `promptSnippet` were
    // never on it, so both recorded a constant on every tool of every turn:
    // label always fell back to name, promptSnippet always to null.
    // sourceInfo replaces them with something that varies — which package a
    // tool came from, i.e. what a --tools allowlist would actually be cutting.
    const tools = pi.getAllTools().map(t => ({
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters ?? null,
      promptGuidelines: t.promptGuidelines ?? null,
      sourceInfo: t.sourceInfo ?? null,
    }));

    const systemPromptSha = sha256(systemPrompt);
    const toolSchemasSha = sha256(JSON.stringify(tools));
    maybeWriteSessionHeader(systemPrompt, systemPromptSha, tools, toolSchemasSha);

    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";

    turns.set(turnKey(runIndex, turnIndex), {
      runIndex,
      turnIndex,
      startTime: Date.now(),
      systemPromptSha,
      toolSchemasSha,
      model,
      thinkingLevel: ctx.thinkingLevel ?? "off",
      toolCalls: [],
    });
  });

  pi.on("turn_end", (event, ctx) => {
    const turnIndex = event.turnIndex;
    const key = turnKey(runIndex, turnIndex);
    const record = turns.get(key);
    if (!record) return;

    const endTime = Date.now();
    const latencyMs = endTime - record.startTime;
    // event.message is the AgentMessage union — user, bashExecution, custom,
    // branchSummary, compactionSummary, assistant. Only the assistant variant
    // carries usage/content/stopReason, so narrow once here instead of casting
    // at each access. A non-assistant message yields nulls, exactly as the
    // previous optional chaining did.
    const raw = event.message;
    const msg = raw && raw.role === "assistant" ? raw : null;
    const usage = msg?.usage ?? null;

    // pi-ai normalises every provider's usage into its own Usage shape before
    // this hook sees it: input/output/cacheRead/cacheWrite/reasoning. The
    // probe list below was guessing at provider-native names that pi has
    // already translated away, which is why cacheReadTokens was null on every
    // recorded turn while rawUsage.cacheRead held the real number. Canonical
    // names go first; the native aliases stay as a fallback in case a raw
    // provider object ever reaches here untranslated.
    const u = usage as unknown as Record<string, unknown> | null;
    const input = firstNumber(usage?.input, u?.inputTokens, u?.promptTokens);
    const output = firstNumber(usage?.output, u?.outputTokens, u?.completionTokens);
    const cacheReadTokens = firstNumber(usage?.cacheRead, u?.cache_read_input_tokens, u?.cacheReadInputTokens);
    const cacheWriteTokens = firstNumber(usage?.cacheWrite, u?.cache_creation_input_tokens, u?.cacheCreationInputTokens);
    // A subset of output, not an addition to it — do not sum the two.
    const reasoningTokens = firstNumber(usage?.reasoning);

    // Context going into this turn, as the provider reports it. The previous
    // field summed input+output across all prior turns, which assumed `input`
    // was a per-turn delta. It isn't, for every provider: openrouter/free
    // sends a full context snapshot each turn, so the sum double-counted and
    // reached 1,180,335 "context tokens" — larger than any real window. When
    // input is a full snapshot these three fields already are the context;
    // when it's a delta this under-reports, which is why rawUsage is kept.
    const contextTokens =
      input == null && cacheReadTokens == null && cacheWriteTokens == null
        ? null
        : (input ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);

    // Share of that context served from cache. Denominator is the whole
    // context, so cache *writes* count against the rate rather than being
    // ignored as they were before.
    const cacheHitRate =
      cacheReadTokens != null && contextTokens != null && contextTokens > 0
        ? cacheReadTokens / contextTokens
        : null;

    const reasoning = capture(extractThinkingParts(msg?.content));
    const text = capture(extractTextParts(msg?.content));

    // Anything the model emitted that `tool_call` never saw was rejected before
    // dispatch. Flagged rather than merged silently, so a call that ran and one
    // that was refused don't read the same.
    const dispatched = new Set(record.toolCalls.map((c) => c.toolCallId));
    const rejected = extractToolCallParts(msg?.content)
      .filter((e) => !dispatched.has(e.id))
      .map((e) => ({
        toolCallId: e.id,
        toolName: e.name,
        input: e.arguments,
        rejectedPreDispatch: true,
      }));

    writeEntry({
      type: "turn",
      incomplete: false,
      sessionId,
      timestamp: new Date().toISOString(),
      runIndex: record.runIndex,
      turnIndex,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      systemPromptSha: record.systemPromptSha,
      toolSchemasSha: record.toolSchemasSha,
      toolCalls: [...record.toolCalls, ...rejected],
      tokenSplit: {
        input,
        output,
        reasoningTokens,
        cacheReadTokens,
        cacheWriteTokens,
        cacheHitRate,
        contextTokens,
      },
      // Verbatim, because every field above is a guess at this provider's
      // naming and those guesses have already missed once: no cache metric
      // was captured on any of 223 recorded turns across two providers, and
      // the raw object being discarded made it impossible to tell whether the
      // provider reported nothing or reported it under another name.
      rawUsage: usage,
      latencyMs,
      // Cheaper per byte than anything else here: separates "the model chose to
      // stop" from "it hit the length cap" from "the provider errored", which
      // are otherwise all just a turn that produced no tool call.
      stopReason: msg?.stopReason ?? null,
      modelReasoning: reasoning?.text ?? null,
      modelReasoningChars: reasoning?.chars ?? null,
      modelText: text?.text ?? null,
      modelTextChars: text?.chars ?? null,
      toolResults: event.toolResults ?? [],
    });

    turns.delete(key);
  });

  // Collect tool calls per turn for richer forensics.
  // NOTE: this still uses a "most recently started, unfinished turn"
  // heuristic, same as before — fine for the single-turn-in-flight case this
  // extension targets, but not safe under concurrent turns.
  pi.on("tool_call", (event, ctx) => {
    const entries = Array.from(turns.entries());
    if (entries.length === 0) return;
    const [, lastRecord] = entries[entries.length - 1];
    lastRecord.toolCalls.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });
  });

  pi.registerCommand("flight-recorder", {
    description: "Show flight recorder log path; `json [path]` converts a log to a pretty JSON array",
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);

      if (subcommand !== "json") {
        // The file is created on the first append, so a session that hasn't run
        // a turn yet has a path but no file. Say which, rather than pointing at
        // something that isn't there.
        const state = existsSync(logPath) ? "" : " (no turns recorded yet)";
        ctx.ui.notify(`Flight recorder: ${logPath}${state}`, "info");
        return;
      }

      // Defaults to this session's log, but takes a path so past sessions in
      // ~/.pi/agent/flight-recorder can be converted without leaving the TUI.
      const sourcePath = rest.length > 0 ? rest.join(" ") : logPath;
      if (!existsSync(sourcePath)) {
        ctx.ui.notify(`No flight recorder log at ${sourcePath}`, "error");
        return;
      }

      let outPath: string;
      let summary: { json: string; records: number; skipped: number };
      try {
        summary = jsonlToArray(sourcePath);
        outPath = sourcePath.replace(/\.jsonl$/, "") + ".json";
        writeFileSync(outPath, summary.json + "\n", { encoding: "utf-8" });
      } catch (err) {
        ctx.ui.notify(`Flight recorder conversion failed: ${String(err)}`, "error");
        return;
      }

      const skipped = summary.skipped > 0 ? `, ${summary.skipped} unparseable line(s) skipped` : "";

      // Attempted separately: a multi-megabyte log can defeat the clipboard on
      // some platforms, and losing the copy must not lose the file that was
      // already written.
      try {
        await copyToClipboard(summary.json);
        ctx.ui.notify(`${summary.records} record(s) → ${outPath} (copied to clipboard${skipped})`, "info");
      } catch {
        ctx.ui.notify(`${summary.records} record(s) → ${outPath} (clipboard copy failed${skipped})`, "warning");
      }
    },
  });
}