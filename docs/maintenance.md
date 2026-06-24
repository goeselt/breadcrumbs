# Maintenance

Operational procedures for maintainers. Contributors do not need this to open a PR -- see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Packaging

Build a `.vsix` for manual installation or publishing:

```bash
npm run package
```

The script runs `vsce package --no-dependencies` (esbuild bundles everything into `out/`, so node modules are not
shipped). `.vscodeignore` controls what is excluded from the package.

## Dependency And Engine Updates

Pin the VS Code engine and `@types/vscode` to the latest published API:

```bash
npm run update
```

This sets `engines.vscode` and installs the matching `@types/vscode`. Review the diff -- raising the engine drops
support for older VS Code versions.

## Release

Releases are driven by the merged PR title, which must follow
[Conventional Commits](https://www.conventionalcommits.org/). The pipeline derives the next version from the title
(`feat:` -> minor, `fix:` -> patch, `feat!:`/`BREAKING CHANGE` -> major). No manual version bump or changelog edit is
required.

## Load Benchmark

Measure cold (uncached) vs. warm (cached) index load time for a provider against real local logs:

```bash
npm run bench -- --provider claude
npm run bench -- --provider codex --runs 5
```

Without `--storage`, the benchmark runs in a throwaway temporary cache directory and leaves the extension's real cache
untouched. See [src/bench.ts](../src/bench.ts).
