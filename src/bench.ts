// Cold-vs-warm load benchmark for the persistent metadata index. Bundled and run via `bench.mjs`.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { AGENTS, type AgentId } from './agent.js'
import type { ChatMetadataReport } from './chat-metadata.js'
import { readIndexedChatMetadata } from './index/chat-metadata-index.js'

interface BenchArgs {
  provider: AgentId
  source?: string
  storage?: string
  runs: number
}

function parseArgs(argv: string[]): BenchArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      values.set(key, 'true')
    } else {
      values.set(key, next)
      index += 1
    }
  }
  const provider = values.get('provider')
  if (!provider || !AGENTS.some((agent) => agent.id === provider)) {
    throw new Error('Usage: npm run bench -- --provider <claude|codex|copilot> [--source <path>] [--runs <n>]')
  }
  const runs = Number(values.get('runs') ?? '3')
  return {
    provider: provider as AgentId,
    source: values.get('source'),
    storage: values.get('storage'),
    runs: Number.isFinite(runs) && runs > 0 ? Math.floor(runs) : 3,
  }
}

async function timeLoad(
  provider: AgentId,
  storageRoot: string,
  source: string | undefined,
): Promise<{ ms: number; report: ChatMetadataReport }> {
  const start = performance.now()
  const report = await readIndexedChatMetadata(provider, { storageRoot, source })
  return { ms: performance.now() - start, report }
}

function summarizeModes(report: ChatMetadataReport): string {
  const counts = new Map<string, number>()
  for (const file of report.index?.files ?? []) counts.set(file.mode, (counts.get(file.mode) ?? 0) + 1)
  return [...counts].map(([mode, count]) => `${mode} x${count}`).join(', ') || 'no files'
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const storageRoot = args.storage ?? (await mkdtemp(path.join(tmpdir(), 'breadcrumbs-bench-')))
  const ownsStorage = !args.storage
  try {
    // Invalidate this provider's persistent cache so the first measurement is a true cold build.
    await rm(path.join(storageRoot, 'schema-1', args.provider), { recursive: true, force: true })

    const cold = await timeLoad(args.provider, storageRoot, args.source)
    const warmRuns: number[] = []
    for (let run = 0; run < args.runs; run += 1) {
      warmRuns.push((await timeLoad(args.provider, storageRoot, args.source)).ms)
    }
    const warm = median(warmRuns)
    const speedup = warm > 0 ? cold.ms / warm : 0

    process.stdout.write(
      [
        `provider:   ${args.provider}`,
        `source:     ${cold.report.source.path}`,
        `chats:      ${cold.report.chats.length} (${cold.report.index?.files.length ?? 0} files)`,
        `cold build: ${cold.ms.toFixed(1)} ms  [${summarizeModes(cold.report)}]`,
        `warm load:  ${warm.toFixed(1)} ms (median of ${args.runs})`,
        `speedup:    ${speedup.toFixed(1)}x`,
        '',
      ].join('\n'),
    )
  } finally {
    if (ownsStorage) await rm(storageRoot, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
