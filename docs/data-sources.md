# Data Sources

This is the implementation reference for supported provider sources, observed fields, and parser invariants.

## Compatibility Warning

The local Codex and Claude JSONL stores are provider implementation details, not public compatibility contracts. Copilot
OTel uses documented concepts, but the exact emitted event mix can still vary by Visual Studio Code and extension
version. Any of these shapes can change without notice.

Breadcrumbs therefore records parser/source-format versions, ignores unknown fields, exposes confidence and warnings,
isolates failures per file/provider, and retains the last successful indexed result when a refresh fails. Provider
source definitions live in `src/adapters/registry.ts`, so a future source-shape change should usually be handled by one
adapter entry plus focused fixtures/tests instead of cross-cutting index changes. Golden fixtures document observed
shapes; they do not guarantee future provider compatibility.

## GitHub Copilot Chat

Official source:

- <https://code.visualstudio.com/docs/agents/guides/monitoring-agents>

Current understanding:

- Visual Studio Code Copilot Chat can emit OpenTelemetry signals for agent interactions.
- OTel can be enabled by Visual Studio Code settings or environment variables.
- Important settings:
  - `github.copilot.chat.otel.enabled`
  - `github.copilot.chat.otel.exporterType`
  - `github.copilot.chat.otel.outfile`
  - `github.copilot.chat.otel.captureContent`
  - `github.copilot.chat.otel.dbSpanExporter.enabled`
- `dbSpanExporter.enabled=true` persists hierarchical spans in a local SQLite database and implicitly enables OTel.
- `exporterType=file` plus `outfile=<path>` gives a flatter JSONL stream suitable as a fallback source.
- `captureContent=false` is the default. Enabling it can expose prompts, responses, code, tool data, and secrets.

Breadcrumbs source priority:

1. `agent-traces.db` under the active Visual Studio Code user-data `globalStorage/github.copilot-chat` directory.
2. Configured OTel JSONL output.
3. Workspace debug logs are detected as a supplemental source but are not yet indexed.

If the trace database exists but its schema no longer matches the required allowlisted tables/columns, Breadcrumbs
treats the trace source as unavailable for that refresh and falls back to JSONL. The report source note includes the
trace schema warning so the user can see that the richer source was skipped.

Observed trace database schema:

- `spans`: hierarchy, operation, model, token, tool, session, timing, and status columns.
- `span_attributes`: prompt/response, reasoning, system instruction, repository, tool argument/result, and auxiliary
  attributes.
- `span_events`: `user_message`, `turn_start`, `turn_end`, `tools_available`, and exception events.
- Real chat sessions are selected from `invoke_agent GitHub Copilot Chat` roots with a `chat_session_id`.
- Child `chat` spans define model requests and token usage. Root `invoke_agent` token totals aggregate descendants and
  must not be added again.
- `parent_span_id` and `tool_call_id` provide the preferred detail-tree relationships.

Useful metadata fields documented by Visual Studio Code:

- `gen_ai.agent.name`
- `gen_ai.conversation.id`
- `gen_ai.request.model`
- `gen_ai.response.model`
- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`
- `gen_ai.usage.cache_read.input_tokens`
- `gen_ai.usage.cache_creation.input_tokens`
- `gen_ai.usage.reasoning.output_tokens`
- `gen_ai.tool.name`
- `github.copilot.agent.type`
- `copilot_chat.time_to_first_token`
- `copilot_chat.agent.turn.count`

Observed JSONL fallback details:

- `copilot_chat.session.start` carries `session.id`; this is currently the most reliable chat identifier.
- `gen_ai.client.inference.operation.details` carries request/response model and token usage.
- `copilot_chat.agent.turn` repeats the main inference token usage and must not be added again.
- Auxiliary model inference events can have no trace ID and require time-window assignment to a session.
- No session-end event was observed; infer the end from the final assigned event.

Content-risk fields:

- `gen_ai.input.messages`
- `gen_ai.output.messages`
- `gen_ai.tool.definitions`
- `gen_ai.tool.call.arguments`
- `gen_ai.tool.call.result`
- `github.copilot.tool.parameters.command`
- `github.copilot.tool.parameters.file_path`

Implementation notes:

- Treat either `dbSpanExporter.enabled=true` or `otel.enabled=true` as telemetry enabled.
- Prefer the trace database because it preserves hierarchy and identifiers.
- Use the configured `breadcrumbs.copilotOtelFile` override, then Copilot's `outfile`, only when no trace database
  exists.
- Keep Copilot trace database parsing defensive: validate expected tables/columns before running span queries; do not
  assume internal SQLite schema compatibility across VS Code/Copilot releases.
- Show `captureContent` as optional detail enrichment, not as a readiness requirement.
- Debug-log directories can contain `main.jsonl`, `runSubagent-*.jsonl`, `title-*.jsonl`, and `models.json`; their shape
  is less stable and currently only reported as a supplemental detected source.

## OpenAI Codex / `openai.chatgpt`

Official source:

- <https://developers.openai.com/codex/IDE>

Current understanding:

- The Visual Studio Code extension is `openai.chatgpt`.
- The extension integrates Codex in the IDE and shares behavior/configuration with the Codex agent/CLI family.
- Local machine state includes Codex session files under `~/.codex/sessions/**/*.jsonl`.

Observed local source shape:

- Top-level JSONL records have `timestamp`, `type`, and `payload`.
- Token fields observed in session files:
  - `payload.info.last_token_usage.input_tokens`
  - `payload.info.last_token_usage.cached_input_tokens`
  - `payload.info.last_token_usage.output_tokens`
  - `payload.info.last_token_usage.reasoning_output_tokens`
  - `payload.info.last_token_usage.total_tokens`
  - `payload.info.total_token_usage.input_tokens`
  - `payload.info.total_token_usage.cached_input_tokens`
  - `payload.info.total_token_usage.output_tokens`
  - `payload.info.total_token_usage.reasoning_output_tokens`
  - `payload.info.total_token_usage.total_tokens`
- Model fields observed:
  - `payload.model`
  - `payload.collaboration_mode.settings.model`
  - `payload.model_provider`
- Other useful fields:
  - `payload.turn_id`
  - `payload.model_context_window`
  - `payload.rate_limits.limit_id`

Content risk:

- Treat every Codex session JSONL file as content-bearing.
- Parser must read record-by-record and extract only explicit usage/model/timestamp/session fields.
- Do not render raw JSON.

Potential Visual Studio Code log source:

- `~/.vscode-server/data/logs/**/openai.chatgpt/Codex.log`
- Local observation shows some `ephemeral_generation_token_usage` lines for thread-title generation.
- This log is secondary because session JSONL has richer agent-turn usage data.

## Anthropic Claude Code / `anthropic.claude-code`

Official source:

- <https://code.claude.com/docs/en/monitoring-usage>

Current understanding:

- The Visual Studio Code extension is `anthropic.claude-code`.
- Extension settings include `claudeCode.environmentVariables`, which can pass telemetry-related environment variables
  to Claude.
- Claude Code has official monitoring/usage events and OpenTelemetry support.

Official event fields worth mapping:

- `model`
- `cost_usd`
- `duration_ms`
- `input_tokens`
- `output_tokens`
- `cache_read_tokens`
- `cache_creation_tokens`
- `request_id`
- `speed`
- `query_source`

Observed local source shape:

- Session files under `~/.claude/projects/**/*.jsonl`.
- Token fields observed:
  - `message.model`
  - `message.usage.input_tokens`
  - `message.usage.output_tokens`
  - `message.usage.cache_creation_input_tokens`
  - `message.usage.cache_read_input_tokens`
  - `message.usage.cache_creation.ephemeral_1h_input_tokens`
  - `message.usage.cache_creation.ephemeral_5m_input_tokens`
  - `message.usage.iterations.*.input_tokens`
  - `message.usage.iterations.*.output_tokens`
  - `message.usage.server_tool_use.web_fetch_requests`
  - `message.usage.server_tool_use.web_search_requests`
- Other useful fields:
  - `sessionId`
  - `timestamp`
  - `cwd`
  - `gitBranch`
  - `version`
  - `userType`

Content risk:

- Treat every Claude session JSONL file as content-bearing.
- Parser must ignore message text, tool inputs, tool results, attachments, and snapshots.

Potential Visual Studio Code log source:

- `~/.vscode-server/data/logs/**/Anthropic.claude-code/Claude VSCode.log`
- Secondary source; local JSONL and official OTel are likely more useful.

## Normalization Notes

Provider field mapping:

| Normalized field           | Copilot OTel                                               | Codex JSONL                                          | Claude JSONL / OTel                     |
| -------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| `provider`                 | constant `copilot`                                         | constant `codex`                                     | constant `claude`                       |
| `sessionId`                | observed `session.id`; documented `gen_ai.conversation.id` | `session_meta.payload.id` or filename                | `sessionId`                             |
| `timestamp`                | event/span timestamp                                       | top-level `timestamp`                                | top-level `timestamp`                   |
| `model`                    | `gen_ai.response.model` or `gen_ai.request.model`          | `payload.model` or collaboration setting             | `message.model` or `model`              |
| `inputTokens`              | `gen_ai.usage.input_tokens`                                | `*.input_tokens`                                     | `message.usage.input_tokens`            |
| `outputTokens`             | `gen_ai.usage.output_tokens`                               | `*.output_tokens`                                    | `message.usage.output_tokens`           |
| `cachedInputTokens`        | `gen_ai.usage.cache_read.input_tokens`                     | `*.cached_input_tokens`                              | `message.usage.cache_read_input_tokens` |
| `cacheCreationInputTokens` | `gen_ai.usage.cache_creation.input_tokens`                 | not yet observed as top-level normalized Codex field | `message.usage.cache_creation_*`        |
| `reasoningOutputTokens`    | `gen_ai.usage.reasoning.output_tokens`                     | `*.reasoning_output_tokens`                          | not yet observed                        |
| `estimatedCostUsd`         | not documented in Visual Studio Code Copilot OTel page     | not observed locally                                 | `cost_usd` in Claude monitoring events  |

Parser invariants:

- Missing data remains unavailable; never infer tokens from text.
- Do not estimate cost or credits unless a future feature explicitly selects and versions a pricing source.
- Preserve provider-specific token-total semantics.
- See [`chat-metadata.md`](chat-metadata.md) for the implemented normalized report.
