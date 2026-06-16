# Breadcrumbs

Visual Studio Code extension for inspecting local coding-agent activity and token usage. It reads GitHub Copilot Chat,
OpenAI Codex, and Anthropic Claude Code data already on disk and never uploads it.

> [!WARNING]
>
> Breadcrumbs is a beta. Views, settings, and report formats can still change between releases.

## Quick Start

1. Download the latest `.vsix` from the [Releases](https://github.com/goeselt/breadcrumbs/releases) page.
2. In Visual Studio Code, run **Extensions: Install from VSIX...** and select the downloaded file.
3. Open **Breadcrumbs** from the Activity Bar.
4. Run **Breadcrumbs: Refresh Usage Index**.

Requires Visual Studio Code `1.120.0` or newer.

## Features

- Provider readiness and source diagnostics.
- Provider-specific usage, model, cache, token, and quality overviews.
- Chronological chat inventories with provider-maintained or derived titles.
- Detailed action trees for requests, messages, reasoning, tools, results, and subagents.
- Per-request and cumulative token development inside a chat.
- Metadata-only JSON export.
- Incremental local indexing with parser diagnostics and stale-result fallback.
- Structured diagnostic log ("Breadcrumbs Log" in the Output view) for troubleshooting; verbosity is controlled via
  **Developer: Set Log Level...**.

Provider formats and token semantics differ, so totals remain provider-scoped; Breadcrumbs does not infer exact billing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
