# Breadcrumbs Terminology Cheat Sheet

This document explains the terms used in Breadcrumbs reports. It is intended to provide a practical mental model, not to
replace provider documentation.

The most important hierarchy is:

```text
provider
  -> chat/session
    -> user turns
      -> one or more model requests
        -> zero or more tool calls
```

A single user message can therefore cause many model requests. Each tool result can be added to the context and sent to
the model in another request. This is why a chat with eight visible turns can contain significantly more than eight
requests.

## Core Entities

### Provider

The product or runtime that produced the source data.

Breadcrumbs currently uses:

- `copilot`: GitHub Copilot and the integrated Visual Studio Code chat runtime.
- `codex`: OpenAI Codex, including sessions used through `openai.chatgpt`.
- `claude`: Anthropic Claude Code, including sessions used through `anthropic.claude-code`.

The provider is not necessarily the model vendor. For example, Copilot can route a request to an Anthropic or OpenAI
model while the provider remains `copilot`.

### Chat / Session

A user-visible conversation or agent task that persists across multiple messages and model calls.

A chat commonly contains:

- the initial user task;
- follow-up user messages;
- system and developer instructions;
- selected workspace files and repository information;
- model responses;
- tool calls and their results;
- internal retries, summaries, or helper-model requests.

Breadcrumbs uses the provider's session identifier where one is available. A source file can also represent one session,
as is normally the case for local Codex and Claude JSONL files.

Do not interpret a chat as one billable request. It is a container around requests.

### Turn

A logical step in the conversation.

From a user's perspective, a turn often means one user message followed by an answer. In an agent loop, the provider may
use a narrower definition: one model decision, one tool-use cycle, or another provider-specific step.

Breadcrumbs only reports `turns` when the source exposes a sufficiently stable turn identifier. Turn counts are useful
inside one provider, but should not be treated as directly comparable across providers.

### Request / Model Request / Inference

One invocation of a language model.

A request sends a package of input to a model and receives output. The input may include much more than the latest user
message:

- system and developer instructions;
- conversation history;
- selected files and code fragments;
- tool definitions;
- previous tool results;
- agent, skill, or repository instructions;
- images or other supported input.

An agent typically makes another request after a tool call so the model can inspect the result and decide what to do
next. Providers may also make auxiliary requests for routing, query rewriting, summarization, safety checks, or chat
titles.

In Breadcrumbs, `requests` means the number of model-usage records that survived provider-specific deduplication. It
does not mean:

- number of user prompts;
- number of HTTP attempts;
- number of billable Copilot credits;
- number of visible assistant messages.

### Request ID

A provider-generated identifier for one API request or response.

It is useful for deduplication and diagnostics. It is not always globally unique, consistently present, or suitable as a
chat identifier. Breadcrumbs does not require every provider to expose one.

### Model

The language model that processed a request, for example a Claude, GPT, or Codex model.

One chat can use several models. A provider may use:

- the user-selected primary model;
- smaller helper models for routing or search preparation;
- a different model after automatic selection;
- separate models for subagents.

The per-model breakdown is therefore often more informative than a single chat-level model label.

## Tokens

### Token

A token is a unit the model uses to process data. It is not the same as a word or character.

Text is split into token pieces. A short common word might be one token, while a long identifier, unusual word, path, or
code expression can require several. Images, audio, and other modalities can also be represented by provider-specific
token units.

Token counts are useful because they influence:

- context-window occupancy;
- request latency;
- cache behavior;
- rate limits;
- cost or credit consumption;
- how much room remains for reasoning and output.

Do not estimate tokens by counting words. Use provider-reported usage whenever possible.

### Input Token

A token sent to the model as part of a request.

Input tokens can originate from:

- the user's latest prompt;
- previous conversation messages;
- system and developer instructions;
- `AGENTS.md`, skills, custom instructions, or agent definitions;
- source files and search results;
- tool declarations and tool results;
- generated summaries or compacted history.

This explains why a ten-word user prompt can produce tens of thousands of input tokens. The prompt is only one part of
the assembled context.

Provider caveat:

- OpenAI/Codex commonly reports cached input as a subset or breakdown of input tokens.
- Claude reports uncached input, cache creation, and cache reads as separate components.
- Copilot OTel follows OpenTelemetry conventions, but exporter versions and underlying models may expose different
  optional cache details.

Always inspect `totalTokenSemantics` before adding token fields.

### Cached Input Token

An input token whose previously processed prompt prefix could be reused from a provider-side prompt cache.

The model still receives the logical context. Caching avoids repeating part of the computational work needed to process
an identical prefix. Cached input commonly improves latency and can use a lower billing rate.

Typical cacheable data includes stable prefixes such as:

- system instructions;
- tool definitions;
- repository instructions;
- long conversation history that remains unchanged;
- repeated file or document context.

The field does not mean Breadcrumbs or Visual Studio Code saved a readable copy of the prompt. Prompt caching is a
provider-side model optimization.

In Breadcrumbs:

- Codex `cachedInputTokens` is treated as a subset of `inputTokens`; do not add it again to calculate total tokens.
- Claude `cachedInputTokens` maps to cache-read tokens and is a separate input component.
- Copilot cache fields, when present, are retained as reported; consult `totalTokenSemantics`.

### Cache Creation Input Token

An input token used to create or refresh a provider-side prompt-cache entry.

The first request with a reusable prompt prefix can require cache creation. Later requests with the same prefix may
report cache reads instead. Cache creation can have a different price from normal input and cache reads.

A high cache-creation value is not automatically bad. It can be an investment that makes later requests cheaper or
faster. It becomes suspicious when similar context is repeatedly written but rarely read, which can indicate unstable
prompt prefixes or frequently changing instructions.

This field is especially explicit in Claude usage data. It may be absent or represented differently in other providers.

### Cache Read Input Token

A token retrieved from an existing prompt-cache entry for the current request.

Breadcrumbs normalizes this as `cachedInputTokens`. A high cache-read share usually means a large stable context prefix
was successfully reused.

It does not mean the token is free. Cache reads can have their own price and may still count toward some provider
limits.

### Output Token

A token generated by the model.

Output can include:

- visible assistant text;
- code;
- structured output;
- tool-call names and arguments;
- internal protocol data;
- reasoning tokens, depending on provider usage semantics.

For OpenAI reasoning models, reported `outputTokens` includes the generated output allocation, while
`reasoningOutputTokens` is a breakdown within it. Do not add reasoning tokens to output tokens again unless a provider's
source explicitly defines them as separate.

### Reasoning Output Token

A token used by a reasoning-capable model for internal deliberation.

Reasoning tokens may not be shown as readable text to the user. They can still:

- occupy context-window capacity during the request;
- contribute to output-token billing;
- increase request duration;
- leave less room for visible output.

Breadcrumbs treats `reasoningOutputTokens` as a provider-reported breakdown, not an additional token category to add on
top of `outputTokens`.

Not every model or provider exposes this field.

### Total Tokens

A provider-normalized total for one request, model, chat, or report.

There is no safe universal formula across all sources:

```text
OpenAI/Codex:
  total ~= inputTokens + outputTokens
  cachedInputTokens is normally already included in inputTokens

Claude local session data:
  total input = inputTokens + cacheCreationInputTokens + cachedInputTokens
  total = total input + outputTokens

Copilot OTel:
  Breadcrumbs uses reported inputTokens + outputTokens
  cache fields are retained as additional breakdowns when available
```

Every Breadcrumbs token object therefore includes `totalTokenSemantics`. Consumers should use this field instead of
assuming that all provider totals were assembled in the same way.

### Token Ratio

A derived comparison between token categories.

Examples:

- Cache-read ratio: how much input was reused from cache.
- Output-to-input ratio: how much the model generated relative to supplied context.
- Context utilization: how much of the model's context window one request occupied.

Ratios are useful for finding trends, but they are not quality scores. A high cache ratio may be efficient; a high input
count may be necessary for a large codebase; a low output count can be either concise or incomplete.

## Context

### Context

Everything assembled for the model to consider in one request.

Context is broader than the user's prompt. It can include instructions, history, files, tool definitions, tool results,
search results, images, and provider-generated state.

In an agent loop, each tool result commonly becomes context for the next request. Long-running chats therefore tend to
grow unless the provider trims, summarizes, or compacts older information.

### Context Window

The maximum token capacity a model can consider for one request.

Depending on the model and API, this capacity can include:

- input tokens;
- generated output tokens;
- reasoning tokens.

The context window is a per-request limit, not a total allowance for the entire chat. A chat can consume millions of
tokens over time while each individual request remains below the model's context-window limit.

### Model Context Window

The provider-reported maximum context capacity for the active model. Breadcrumbs exposes `modelContextWindow` when the
source contains it.

This is useful for estimating whether a request is close to its model limit. It does not reveal how much context is
actually relevant or useful.

### Context Bloat

The repeated inclusion of more context than a task needs.

Possible symptoms:

- input tokens rise quickly from turn to turn;
- the same large files or instructions are repeatedly loaded;
- tool outputs accumulate without compaction;
- latency increases while output quality does not;
- cache creation remains high and cache reuse remains low.

Large context is not automatically bloat. The term describes context whose marginal value is low relative to its token,
latency, or billing impact.

## Agent Activity

### Agent Loop

The repeated cycle in which an agent:

1. evaluates the current state;
2. asks a model for the next action;
3. invokes a tool or produces an answer;
4. adds the result to context;
5. makes another model request if needed.

This is the main reason request count, tool-call count, and token usage can be much larger than the number of visible
user messages.

### Tool Call

An instruction from the model or agent runtime to perform an action outside normal text generation.

Examples:

- read or search files;
- edit code;
- run a terminal command;
- execute tests;
- query an MCP server;
- search the web.

Tool output normally becomes input context for a later model request. A tool call can therefore have both direct runtime
cost and indirect token cost.

### Tool Duration

The time spent executing a tool.

It is not model inference time. A long terminal command, test suite, network request, or user approval can dominate tool
duration without consuming model tokens during that period.

### Subagent

An additional agent delegated a focused task by a parent agent.

A subagent can have its own model requests, tools, context, and token usage. Whether Breadcrumbs can attribute those
requests separately depends on the provider metadata.

## Time And Performance

### Wall-Clock Duration

Elapsed time between the first and last observed record for a chat:

```text
wallClockDurationMs = endedAt - startedAt
```

This can include:

- user thinking or idle time;
- approval delays;
- model requests;
- tool execution;
- retries;
- background work.

It should not be presented as model latency.

### Request Duration / Model Duration

Provider-reported time associated with one model request or completed model turn.

The exact boundary is provider-specific. It may include network transport, retries, streaming, or runtime overhead.
Breadcrumbs only emits `performance.modelDurationMs` when the selected source provides a meaningful duration.

### Time To First Token (TTFT)

Time from starting a model request until the first output token becomes available.

TTFT captures perceived responsiveness better than total duration for streamed responses. It is influenced by:

- model and service load;
- input-context size;
- cache hits;
- network latency;
- provider queueing.

TTFT does not describe how long the complete answer took.

### Average Time To First Token

The arithmetic average of the observed request or turn TTFT values in a chat.

An average can hide slow outliers. A future production report may also expose median and percentile values when enough
samples exist.

## Billing And Limits

### Cost

A currency value attributed by a provider to usage.

Exact cost requires more than token totals:

- model and model version;
- input, cached-input, cache-write, output, and reasoning prices;
- service tier;
- provider discounts;
- included plan allowances;
- pricing effective at the time of the request.

Breadcrumbs does not silently estimate cost. `billing.status=unavailable` means the selected local source does not
contain a trustworthy provider-reported value.

### Credit / AI Credit

A provider-defined billing or allowance unit. A credit is not a token and not necessarily a request.

For current GitHub Copilot usage-based billing, introduced on June 1, 2026, interaction cost depends on the model and
tokens consumed and is converted to GitHub AI Credits. Some annual subscribers may still be on legacy request-based
billing, where "premium requests" and model multipliers apply.

Breadcrumbs must therefore keep these concepts separate:

- `requests`: observed model invocations;
- `tokens`: model input and output units;
- `credits`: provider billing units;
- `costUsd`: a currency amount.

One cannot be reliably derived from another without provider-specific billing rules and effective dates.

### Premium Request

A legacy GitHub Copilot billing unit for eligible annual plans that remained on request-based billing after June
1, 2026.

It is not the same as Breadcrumbs's model-request count. A user prompt, feature, session, or model multiplier can affect
legacy premium-request consumption according to GitHub's billing rules.

### Rate Limit

A provider constraint on how much usage is allowed during a time window.

Rate limits can be expressed as requests, tokens, percentages, or provider-specific units. A rate-limit snapshot such as
`usedPercent=40` does not show how much one chat cost. It only describes account state near the time it was recorded.

### Plan Type

The subscription or service plan reported by a provider, for example an individual or organizational plan.

Plan type can influence limits and billing, but it is not enough by itself to calculate cost.

## Report Reliability

### Source Path

The local file or directory from which Breadcrumbs extracted metadata.

Codex and Claude session files can contain conversation content even though Breadcrumbs emits only allowlisted metadata.
Copilot OTel can also contain content when content capture is enabled.

### Deduplication

The provider-specific process used to avoid counting repeated telemetry records as new usage.

Examples:

- Copilot agent-turn events can repeat token counts already present in inference events.
- Claude streaming can write several snapshots with the same message ID.
- Codex reports cumulative session totals, so Breadcrumbs uses the latest total and positive deltas.

Without deduplication, token and request totals can be severely inflated.

### Data Quality Confidence

Breadcrumbs's assessment of how directly a report value maps to the source data.

- `high`: stable identifiers and provider-reported values with understood deduplication.
- `medium`: useful values with inferred association or timing boundaries.
- `low`: incomplete or ambiguous source data.

Confidence describes measurement quality, not whether the agent performed well.

### Provider Metadata

Useful fields that do not have a safe cross-provider meaning.

Examples include:

- service tier;
- inference region;
- agent type;
- speed mode;
- stop reason;
- plan type;
- rate-limit snapshots.

These fields remain provider-specific rather than being forced into misleading common metrics.

## Reading A Breadcrumbs Chat

For a first assessment, read fields in this order:

1. `chatId`, `startedAt`, and `wallClockDurationMs`: identify the chat and its observed time span.
2. `turns` and `requests`: determine how many visible/logical steps expanded into model calls.
3. `models`: check whether primary and helper models were used.
4. `tokens.totalTokenSemantics`: establish how this provider's total was calculated.
5. `inputTokens` and cache fields: understand context size and reuse.
6. `outputTokens` and `reasoningOutputTokens`: understand generation volume.
7. `tools`: see which actions may have expanded the agent loop and context.
8. `performance`: separate model timing from total chat time.
9. `billing`: check whether credits or cost are actually available.
10. `dataQuality`: read the caveats before comparing chats or providers.

## Official References

General and Visual Studio Code:

- [Visual Studio Code: Agents and the agent loop](https://code.visualstudio.com/docs/agents/concepts/agents)
- [Visual Studio Code: Tools and their context impact](https://code.visualstudio.com/docs/agents/concepts/tools)
- [Visual Studio Code: Monitor agent usage with OpenTelemetry](https://code.visualstudio.com/docs/agents/guides/monitoring-agents)
- [Visual Studio Code: Debug chat interactions](https://code.visualstudio.com/docs/agents/agent-troubleshooting/chat-debug-view)
- [OpenTelemetry GenAI event conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-events.md)

OpenAI and Codex-related concepts:

- [OpenAI: Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI: Reasoning models and reasoning tokens](https://developers.openai.com/api/docs/guides/reasoning)
- [OpenAI: Conversation state and context windows](https://developers.openai.com/api/docs/guides/conversation-state)
- [OpenAI: API pricing](https://developers.openai.com/api/docs/pricing)

Anthropic and Claude:

- [Anthropic: Prompt caching and token breakdown](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Claude Code: Monitoring usage](https://code.claude.com/docs/en/monitoring-usage)
- [Anthropic: API pricing](https://platform.claude.com/docs/en/about-claude/pricing)

GitHub Copilot billing:

- [GitHub: Copilot billing overview](https://docs.github.com/en/copilot/concepts/billing)
- [GitHub: Usage-based billing for individuals](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals)
- [GitHub: Usage-based billing for organizations and enterprises](https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises)
- [GitHub: Legacy request-based billing](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/github-copilot-premium-requests)
