# Normalized Chat Metadata

This document describes the metadata-only chat list implemented by:

- `src/adapters/copilot.ts`
- `src/adapters/codex.ts`
- `src/adapters/claude.ts`
- `src/adapters/registry.ts`
- `src/chat-metadata.ts`

## Boundary

`CodeQL` is a workload or agent task executed through Visual Studio Code Chat. The provider represented by the adapter
is `copilot`, because the observed records are emitted by GitHub Copilot. CodeQL-specific attribution is not available
in the current metadata unless Copilot emits a stable agent/tool identifier for it.

The adapters parse content-bearing JSON records but keep only explicitly selected metadata in memory after each record.
Reports never emit prompt text, response text, tool arguments, tool results, diffs, or file content. A
provider-maintained chat title is retained when available. Titles can be derived by the provider from conversation
content and must therefore be treated as potentially sensitive metadata.

## Common Output

Each command emits one `ChatMetadataReport` with:

- one provider: `copilot`, `codex`, or `claude`;
- a stable source-level `chatKey` plus the provider's `providerChatId`;
- `kind=main|subagent` and `parentChatKey` where child runs are known;
- source health and parse counts;
- provider-wide token/model totals;
- a newest-first `chats` array;
- provider-maintained title where the local source exposes one;
- per-chat model/request/token totals;
- wall-clock duration;
- provider-reported timing and tool information when available;
- explicit billing availability and data-quality caveats.

Token components are not interchangeable across providers. Every token object includes `totalTokenSemantics`. Sessions
with zero normalized model requests are excluded from reports and totals.

## Provider Mapping

### Copilot

Primary source: Copilot `agent-traces.db`.

Fallback source: configured OTel JSONL file.

Chat identity:

- trace database `chat_session_id`, or JSONL `copilot_chat.session.start` -> `session.id`;
- `chatKey` combines provider, source-path identity, and provider chat ID;
- database `parent_span_id` preserves request/tool hierarchy;
- JSONL trace ID associates traced events;
- trace-less JSONL auxiliary inference calls are assigned only inside the observed lifetime of a traced session.

Aggregation:

- count child database `chat` spans or JSONL `gen_ai.client.inference.operation.details` as model requests;
- exclude aggregate database `invoke_agent` tokens and JSONL `copilot_chat.agent.turn` tokens;
- model from `gen_ai.response.model`, falling back to `gen_ai.request.model`;
- database tools use explicit span and tool-call IDs;
- JSONL tools are deduplicated by timestamp plus tool name.

Available locally:

- input/output tokens and optional cache/reasoning fields;
- per-model request count;
- agent name/type;
- turn count;
- tool call count and tool duration.

Unavailable:

- premium-request credits;
- provider cost;
- reliable model duration in the JSONL fallback.

### Codex

Source: `~/.codex/sessions/**/*.jsonl`, one file per chat.

Title source: read-only `threads.title` lookup in sibling `~/.codex/state_5.sqlite`, joined by thread ID. Missing or
unreadable state databases do not make session metadata unavailable.

Chat identity:

- `session_meta.payload.id`, falling back to the filename.
- `chatKey` additionally includes the source-file identity.

Aggregation:

- positive deltas between cumulative `payload.info.total_token_usage` snapshots are accumulated;
- a decreasing cumulative total starts a new counter segment instead of discarding earlier usage;
- each delta is assigned to the current `turn_context` model;
- per-turn duration and time-to-first-token are joined by `turn_id`;
- workspace, repository, branch, plan, context window, and latest rate-limit snapshots are retained.

Available locally:

- input/cached/output/reasoning/total tokens;
- model and request count;
- turn count;
- model context window;
- summed completed-turn duration and average time-to-first-token;
- plan and rate-limit snapshots.

Unavailable:

- numeric credits in currently observed records (`rate_limits.credits` is null);
- exact per-chat currency cost.

### Claude

Source: `~/.claude/projects/**/*.jsonl`, with main-session and nested subagent files.

Title source: latest observed `ai-title.aiTitle` value for the session.

Chat identity:

- top-level `sessionId`, falling back to the filename.
- `sessionId` is not unique across files: observed subagents reuse the main session ID.
- `chatKey` is the application identity; `parentChatKey` relates subagents to the main session.

Aggregation:

- records with the same `message.id` are streaming snapshots, not separate requests;
- keep only the latest snapshot per `message.id`;
- sum unique messages per model;
- total tokens include uncached input, cache creation, cache read, and output.
- default report totals include main chats only; `totalsIncludingChildren` explicitly includes subagents.

## Persistent Index

`src/index/chat-metadata-index.ts` incrementally indices complete JSONL lines. Provider-specific source knowledge lives
in `src/adapters/registry.ts`: default source paths, source-format identifiers, parser versions, JSONL projection,
aggregation, optional direct sources, and detail dispatch. Provider projectors retain only the fields needed for
metadata aggregation before writing index state. Provider-maintained titles are allowlisted; prompt text, response text,
instructions, tool arguments, and tool results are not persisted.

The index:

- tracks byte offsets and retries an incomplete trailing line;
- detects append, truncation, replacement, deletion, and parser-version changes;
- updates files independently and can retain a stale successful file result after a transient refresh failure;
- records source-format and parser-version per indexed file, not just per provider;
- writes cache files atomically with owner-only file permissions;
- exposes per-file parser diagnostics and refresh mode;
- lets Chat Detail open the indexed source directly without a provider-wide metadata scan.

Available locally:

- input/cache-creation/cache-read/output tokens;
- model and unique message request count;
- service tier, inference geo, speed, stop reasons;
- server-side web search/fetch request counts.

Unavailable:

- reliable per-request/model duration;
- provider-reported local session cost or credits.

## Interpretation Rules

- `wallClockDurationMs` may include user idle time. Do not present it as inference latency.
- `performance.modelDurationMs` is provider-specific and only emitted where directly observed.
- `billing.status=unavailable` means no exact value exists in the selected source. Do not silently estimate it.
- Cached-token fields may be subsets of input or separate components; use `totalTokenSemantics`.
- Reports are suitable for provider comparison only after selecting comparable fields and acknowledging these semantics.
