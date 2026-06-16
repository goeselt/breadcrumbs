# Maintainability Notes

This document is optimized for future coding-agent sessions. It captures the current architecture decisions that make
Breadcrumbs easier to maintain when provider data sources drift.

## Current Direction

Breadcrumbs should treat provider data as unstable local implementation detail. The extension should keep user-facing
reports stable by isolating provider-specific assumptions in adapters and by preserving a narrow normalized output
contract.

The most important implementation boundary is:

- `src/adapters/registry.ts`: provider/source registry. Owns provider source formats, parser versions, default paths,
  JSONL projection, aggregation hooks, direct source readers, and chat-detail dispatch.
- `src/index/chat-metadata-index.ts`: generic JSONL indexing and report assembly. It should not know individual provider
  record shapes.
- `src/adapters/*`: provider-specific projection, summarization, and detail parsing.
- `src/chat-metadata.ts` and `src/chat-detail.ts`: normalized output contracts.

## Source Formats And Parser Versions

Parser versions are source-specific, not provider-wide. A provider can have more than one source:

- Copilot trace SQLite: `copilot-agent-traces-sqlite`, currently parser version `3`.
- Copilot OTel JSONL: `copilot-otel-jsonl`, currently parser version `2`.
- Codex session JSONL: `codex-session-jsonl`, currently parser version `2`.
- Claude project JSONL: `claude-project-jsonl`, currently parser version `2`.

When changing a projector or aggregator in a way that changes persisted indexed metadata semantics, bump the parser
version for that source in `src/adapters/registry.ts` or the direct-source adapter constant. This forces a safe rebuild
of stale JSONL index files.

## Drift Handling Rules

- Unknown fields should be ignored by default.
- Missing optional fields should become `undefined`, not parser failures.
- Missing required source structure should produce a clear warning or low-confidence stale result.
- Existing healthy files should remain usable if another file fails.
- Direct sources with richer data may fall back to less rich sources when marked `fallbackOnError`.
- Never infer token usage from raw text length.
- Never estimate cost/credits unless an explicitly versioned pricing source is added.

## Copilot Trace Database

Copilot `agent-traces.db` is valuable because it preserves hierarchy, tool-call IDs, and request spans. It is also an
internal SQLite database and may change. The adapter validates required tables and columns before querying. If
validation fails, metadata indexing falls back to Copilot OTel JSONL and reports a source note explaining the skipped
trace source.

Relevant tests:

- `src/adapters/copilot-traces.test.ts`: validates trace metadata/detail behavior and malformed schema rejection.
- `src/index/chat-metadata-index.test.ts`: validates JSONL fallback when the trace database schema drifts.

## When Adding Or Changing A Provider Source

1. Add or update the provider/source entry in `src/adapters/registry.ts`.
2. Keep projection allowlisted: persist only metadata required by reports.
3. Add a focused fixture for the observed shape.
4. Add at least one drift test for missing optional/required data.
5. Update `docs/data-sources.md` and `docs/chat-metadata.md`.
6. Run `npm run verify`.

## Open Follow-Ups

- Consider moving source discovery/readiness metadata into the same provider registry once the UI needs fewer
  provider-specific readiness branches.
- Consider watching Copilot trace database changes directly; the current watcher path is still stronger for JSONL
  sources.
- Consider adding schema-shape telemetry to reports, such as observed Copilot trace database table/column hashes, if
  future drift becomes frequent.
