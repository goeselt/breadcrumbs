# Contributing to Breadcrumbs

## Design

| Path                   | Responsibility                                                                   |
| ---------------------- | -------------------------------------------------------------------------------- |
| `src/extension.ts`     | Visual Studio Code lifecycle, commands, provider loading, and view coordination. |
| `src/adapters/`        | Provider-specific metadata and detail parsing.                                   |
| `src/index/`           | Incremental metadata indexing and source watchers.                               |
| `src/views/`           | Native Activity Bar tree providers.                                              |
| `src/webviews/`        | Escaped report rendering (per-page render modules) and panel lifecycle.          |
| `src/chat-metadata.ts` | Normalized metadata and provider-scoped totals.                                  |
| `src/chat-detail.ts`   | Bounded detail report and content-mode model.                                    |
| `src/discovery.ts`     | Extension, setting, and source readiness discovery.                              |
| `src/log.ts`           | Structured "Breadcrumbs Log" output channel (logfmt-style `fields()` helper).    |
| `fixtures/golden/`     | Synthetic provider compatibility fixtures.                                       |

Provider formats stay isolated in `src/adapters/`; the persisted index in `src/index/` stays metadata-only. Provider
record shapes are implementation details that can change without notice -- adapters record source-format and parser
versions, ignore unknown fields, and surface confidence and warnings rather than assume permanent schema compatibility.
Add focused fixtures and tests for every newly accepted provider shape.

Modules under unit test (anything with a sibling `*.test.ts`, e.g. `src/index/chat-metadata-index.ts`,
`src/chat-metadata.ts`) must not import `vscode` directly or transitively -- the module is not resolvable under Vitest.
This includes `src/log.ts`, which imports `vscode` to create the output channel. Log from the nearest caller that
already imports `vscode` (typically `src/extension.ts`, `src/discovery.ts`, or `src/index/watch.ts`) instead of adding
logging to a tested, `vscode`-free module.

## Development Setup

- Node.js 24
- Visual Studio Code 1.120 or newer

```bash
npm ci
npm run build
```

Use the **Run Extension** launch configuration (`F5`) to open an Extension Development Host with Breadcrumbs loaded and
all other extensions disabled. Open **Breadcrumbs** from the Activity Bar and run **Breadcrumbs: Refresh Usage Index**.

## Local Verification

Lint:

```bash
docker pull ghcr.io/goeselt/pedant:latest
docker run --rm -v "$(pwd):/work" ghcr.io/goeselt/pedant:latest
```

Typecheck, test, and build:

```bash
npm run verify
```

Package:

```bash
npm run package
```

## Submitting Changes

Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/). The release
pipeline uses the PR title to determine the next version.
