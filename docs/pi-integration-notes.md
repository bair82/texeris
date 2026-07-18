# Pi integration notes (for Milestone 1+)

**Source:** study of <https://github.com/earendil-works/pi> @ npm `0.80.10`
(2026-07-16), MIT license. All packages ESM-only, **Node >= 22.19.0**.

Status of Pi as a dependency: 0.x, fast cadence, breaking changes between
minor bumps — **pin exact versions**. Provider SDKs load lazily, so depending
on `pi-agent-core` + `pi-ai` only pulls the SDKs of providers we register.

## Embedding level: `Agent` from pi-agent-core

Three layers exist; use the lowest:

1. **`Agent` / `agentLoop` (`@earendil-works/pi-agent-core`)** — headless, no
   fs/TTY/global-state assumptions. ✅ Our `AgentRuntime` adapter wraps this.
2. `AgentHarness` (same package) — sessions + skills + hooks, but its own docs
   say unfinished (no auto-compaction/retry). Revisit later.
3. `createAgentSession()` (pi-coding-agent) — full CLI stack with `~/.pi`
   conventions and extension loading. Too heavy and too trust-sensitive.

Key API (packages/agent/src/agent.ts):

```ts
const agent = new Agent({
  initialState: { systemPrompt, model, thinkingLevel, tools, messages },
  streamFn: (m, c, o) => models.streamSimple(m, c, o), // ALWAYS pass explicitly
  getApiKey, beforeToolCall, afterToolCall, transformContext, convertToLlm,
});
agent.subscribe((event: AgentEvent) => { /* forward to UI */ });
await agent.prompt(text);          // throws while a run is active
agent.steer(msg); agent.followUp(msg);  // mid-run queueing
agent.abort(); await agent.waitForIdle();
```

- Events are **callbacks, not async iterators**: `agent_start/end`,
  `turn_start/end`, `message_start/update/end` (update carries pi-ai
  `AssistantMessageEvent` incl. `text_delta`, `thinking_delta`), and
  `tool_execution_start/update/end`. Map these onto our normalized
  `AgentEvent` union (architecture §12.3).
- Awaited subscribers block run settlement — keep listeners fast.
- Usage/cost: every finalized `AssistantMessage.usage` has token counts and
  cost — feeds our usage records (§13.2).
- Cancellation is first-class `AbortSignal` everywhere; abort preserves
  partial content/usage; `continue()` resumes.
- Gotcha: default `streamFn` uses a legacy global registry (will be removed);
  default model is a placeholder that fails. Both must be set explicitly.

## Custom tools

Plain in-process objects — exactly what our domain-tool boundary needs:

```ts
interface AgentTool {
  name; description; label;
  parameters: TSchema;              // TypeBox (pi-ai re-exports Type)
  execute(toolCallId, params, signal?, onUpdate?) => Promise<{ content, details, terminate? }>;
}
```

- Params are validated against the TypeBox schema before `execute`.
- Tools may be stateful closures; register via `initialState.tools` or
  `agent.state.tools = [...]`.
- Throw from `execute` on failure — the loop reports it to the model as an
  error tool result; don't encode errors in `content`.
- `beforeToolCall` can block (`{ block: true, reason }`) — our approval gate.
- Map to our tool list (architecture §12.2): `read_document`,
  `propose_patch`, `search_archive`, etc. **No fs/shell tools, ever.**

## Providers: Kimi (Deep) + DeepSeek (Fast)

Both are built into pi-ai (`createModels()` collection):

- `moonshotaiProvider()` — `https://api.moonshot.ai/v1`, OpenAI-completions
  API, env `MOONSHOT_API_KEY`. Catalog includes `kimi-k2.5/2.6`,
  `kimi-k2-thinking*`, etc. (separate `moonshotai-cn` for the China endpoint).
- `deepseekProvider()` — `https://api.deepseek.com`, env `DEEPSEEK_API_KEY`.
  Catalog: `deepseek-v4-flash`, `deepseek-v4-pro`.

Arbitrary OpenAI-compatible endpoints are fully supported via
`createProvider({ id, baseUrl, auth, models, api: openAICompletionsApi() })`;
baseURL is per-provider and per-model. Auth precedence: explicit per-request
key > `CredentialStore` > env var; `InMemoryCredentialStore` exists (good for
Electron — no disk secrets). Reasoning effort per request via
`streamSimple(model, ctx, { reasoning })`; per-model `thinkingLevelMap`
handles provider quirks. URL-based compat auto-detection (e.g. DeepSeek
`thinkingFormat`) keys off `baseUrl` — if we ever front the APIs with a
proxy, set `compat` flags explicitly.

Model modes: keep our `ModelModeConfig` (`fast|deep` → provider+model id) and
resolve through one `Models` collection. Verify `model.reasoning` at runtime
(per-model flags live in generated catalogs not visible in source).

## Skills

- Format: directory with `SKILL.md` (YAML frontmatter: `name`, `description`
  required; body = instructions), per the agentskills.io spec. Progressive
  disclosure: names/descriptions go into the system prompt; the model loads
  the body on demand (can be forced with `formatSkillInvocation`).
- Loader: `loadSkills(env, dirs)` — but we can register programmatically and
  skip disk discovery.
- **`allowed-tools` frontmatter is NOT enforced** (experimental; core `Skill`
  type ignores it). Tool restriction must be enforced by Texeris itself —
  per-run tool subsets are supported (`agent.state.tools`, and harness
  `setTools(tools, activeToolNames)`). Our skill contracts (architecture §3.6)
  therefore stay application-enforced, which matches the plan.

## Extensions: skip

Extensions are arbitrary TypeScript executed in-process with full user
permissions (jiti-loaded from disk/npm). That is a code-execution trust
surface we don't need — at the pi-agent-core level the machinery doesn't
exist, and `beforeToolCall`/`afterToolCall` hooks cover interception. Do not
enable extension loading.

## Sessions / persistence

- Persist our own conversations in SQLite (per architecture §12.4) and skip
  Pi's file storage entirely. `AgentMessage`s are plain JSON; re-inject via
  `agent.state.messages = msgs` then `continue()`.
- Caveat: preserve assistant messages verbatim — they carry provider fields
  (`api`, `provider`, `model`, `thinkingSignature`, `stopReason`) needed for
  correct replay, especially across providers.

## Process model (Electron)

- pi-agent-core has zero stdio/TTY references — safe in a `utilityProcess`.
- Check Electron's bundled Node is >= 22.19 when choosing the Electron version.
- If we ever want process isolation instead of in-process: `pi --mode rpc`
  (JSONL over stdio) exists with a TS client — but in-process `Agent` + our
  event normalization is simpler. RPC framing: split on `\n` only, never
  `readline` (U+2028/2029 are valid inside JSON strings).

## Jobs / subagents

None built in (deliberately). Pattern: spawn one `Agent` per job with a
delegated system prompt and tool subset (the repo has a reference extension
doing this via subprocesses). Our job coordinator (architecture §20.4)
implements this on top of the adapter.

## Other gotchas

- `prompt()` while running throws → queue via `steer()`/`followUp()`.
- TypeBox schemas are load-bearing (`typebox` pinned by Pi).
- pi-coding-agent writes `~/.pi/agent/*` by default; we don't use that layer,
  and pi-agent-core writes nothing unless given a `JsonlSessionRepo`.
- Consider our own `.npmrc` `min-release-age` — Pi's supply-chain hardening
  doesn't propagate to consumers.
