# Chat Details

Breadcrumbs resolves a stable `chatKey` into a chronological report describing model requests, messages, reasoning,
tools, results, context categories, token usage, and timing. The extension renders this report as a collapsible action
tree.

## Implementation

- `src/chat-detail.ts`: shared report model, content modes, truncation, and timeline limits.
- `src/adapters/chat-detail.ts`: provider dispatch.
- `src/adapters/copilot-traces.ts`: structured Copilot trace database details.
- `src/adapters/copilot-detail.ts`: Copilot OTel JSONL fallback.
- `src/adapters/codex-detail.ts`: Codex session details.
- `src/adapters/claude-detail.ts`: Claude session and subagent details.
- `src/webviews/report-html.ts`: escaped, bounded tree rendering.

## Content Modes

The selected mode controls which captured text is emitted into the in-memory report and Webview:

- `none`: identifiers, structure, token usage, timing, tool names, and content sizes only.
- `messages`: additionally includes bounded user and assistant message excerpts.
- `tools`: additionally includes bounded tool arguments and results.
- `all`: includes all supported bounded excerpts, including readable reasoning and instructions.

The interactive detail view defaults to `all` in trusted workspaces because the user is inspecting local data.
Restricted Mode forces metadata-only output. Content is escaped, bounded to 2,000 characters per field by the extension,
and is not persisted as Webview state.

## Timeline Rules

- Events are sorted chronologically.
- User messages start action chains when available.
- Provider turn markers are the fallback chain boundary.
- `parentId` creates structural nesting.
- `toolCallId` pairs a tool result with its call when explicit parent information is unavailable.
- Request token usage and cumulative visible usage are shown on model-request nodes.
- The extension limits a detail report to 300 events, preserving the first and last portions when capped.

## Provider Behavior

### Copilot

- Prefers `agent-traces.db` sessions identified by `chat_session_id`.
- Uses `parent_span_id` and `tool_call_id` for hierarchy.
- Counts child `chat` spans as requests and excludes aggregate `invoke_agent` token totals.
- Reads user-message events and captured reasoning, response, tool-argument, and tool-result attributes.
- Falls back to configured OTel JSONL when no trace database exists.

### Codex

- Resolves `session_meta.payload.id`.
- Uses `event_msg` records for messages and lifecycle events.
- Uses `response_item` records for calls, results, web search, developer context, and reasoning summaries.
- Converts cumulative usage snapshots into request deltas.

### Claude

- Resolves the selected JSONL source and top-level `sessionId`.
- Preserves message blocks, tool uses, tool results, thinking blocks, attachments, and meta messages.
- Relates subagent files to their main chat through `parentChatKey`.
- Keeps encrypted or omitted thinking unavailable instead of attempting reconstruction.

## Boundaries

Breadcrumbs does not reconstruct text from token counts, decrypt reasoning, infer missing content, guarantee secret
redaction, or claim that a structural association proves semantic causality.
