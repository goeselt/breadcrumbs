import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentId } from '../agent.js'
import { sourceIdForPath } from '../chat-identity.js'
import { reportTotals, sortChats, type ChatMetadata, type ChatMetadataReport } from '../chat-metadata.js'
import { type JsonlReadStats } from '../jsonl.js'
import { expandHome, toHomeRelative } from '../path.js'
import { providerAdapter, type ProviderAdapter, type SourceFormat } from '../adapters/registry.js'
import {
  loadJsonlIndex,
  refreshJsonlIndex,
  saveJsonlIndex,
  type IndexedJsonlFile,
  type JsonlIndexOptions,
  type ParserDiagnostics,
} from './jsonl-index.js'

export interface IndexedMetadataOptions {
  storageRoot: string
  source?: string
  signal?: AbortSignal
  directSources?: Partial<Record<SourceFormat, string | undefined>>
}

interface IndexedFileResult {
  chats: ChatMetadata[]
  sourceId: string
  sourcePath: string
  mode: 'unchanged' | 'append' | 'rebuild' | 'stale'
  appendedRecords: number
  parserVersion: number
  diagnostics: ParserDiagnostics
  warning?: string
}

export async function readIndexedChatMetadata(
  provider: AgentId,
  options: IndexedMetadataOptions,
): Promise<ChatMetadataReport> {
  const adapter = providerAdapter(provider)
  const directResult = await readDirectMetadataReport(adapter.directSources, options.directSources)
  if (directResult.report) return directResult.report

  const source = expandHome(options.source ?? adapter.jsonlSource.defaultSource)
  const files = await adapter.jsonlSource.listFiles(source)
  const providerStorage = path.join(options.storageRoot, `schema-1`, provider)
  const results = await refreshIndexedFiles(
    files,
    providerStorage,
    {
      parserVersion: adapter.jsonlSource.parserVersion,
      project: adapter.jsonlSource.project,
      signal: options.signal,
    },
    (file, state) => adapter.jsonlSource.summarize(file, state.records, statsFrom(state.diagnostics)),
  )

  await removeStaleCaches(providerStorage, new Set(results.map((result) => result.sourceId)))
  const summarizedChats = results.flatMap((result) => result.chats)
  const enrichedChats = adapter.jsonlSource.afterSummarize
    ? await adapter.jsonlSource.afterSummarize(summarizedChats, source)
    : summarizedChats
  const chats = sortChats(enrichedChats).filter((chat) => chat.requests > 0)
  const mainChats = provider === 'claude' ? chats.filter((chat) => chat.kind === 'main') : chats
  const sourceExists = await pathExists(source)
  const invalidRecords = results.reduce(
    (sum, result) => sum + result.diagnostics.invalidJsonLines + result.diagnostics.unsupportedRecords,
    0,
  )

  return {
    schemaVersion: 2,
    reportType: 'chat-metadata-list',
    provider,
    generatedAt: new Date().toISOString(),
    source: {
      path: toHomeRelative(source),
      exists: sourceExists,
      filesRead: results.length,
      recordsRead: results.reduce((sum, result) => sum + result.diagnostics.recordsRead, 0),
      invalidRecords,
      note: sourceNote(sourceExists, files.length, directResult.warning),
    },
    privacy: {
      contentReadDuringParsing: true,
      contentEmitted: false,
      note: 'The persistent index contains allowlisted metadata records only; raw provider records are not stored.',
    },
    index: {
      storagePath: toHomeRelative(providerStorage),
      files: results.map((result) => ({
        sourceId: result.sourceId,
        sourcePath: result.sourcePath,
        mode: result.mode,
        appendedRecords: result.appendedRecords,
        parserVersion: result.parserVersion,
        diagnostics: result.diagnostics,
        warning: result.warning,
        sourceFormat: adapter.jsonlSource.sourceFormat,
      })),
    },
    totals: reportTotals(mainChats, adapter.tokenSemantics),
    totalsIncludingChildren:
      provider === 'claude' && mainChats.length !== chats.length
        ? reportTotals(chats, adapter.tokenSemantics)
        : undefined,
    chats,
  }
}

async function readDirectMetadataReport(
  sources: ProviderAdapter['directSources'],
  overrides: IndexedMetadataOptions['directSources'],
): Promise<{ report?: ChatMetadataReport; warning?: string }> {
  for (const source of sources ?? []) {
    const candidate = overrides?.[source.sourceFormat] ?? (await source.find())
    if (!candidate) continue

    try {
      return { report: await source.read(candidate) }
    } catch (error) {
      if (!source.fallbackOnError) throw error
      return {
        warning: `${source.sourceFormat} could not be read and JSONL fallback was used: ${errorMessage(error)}`,
      }
    }
  }
  return {}
}

export async function refreshIndexedFiles<T>(
  files: string[],
  storage: string,
  indexOptions: JsonlIndexOptions<T>,
  summarize: (file: string, state: IndexedJsonlFile<T>) => ChatMetadata[],
): Promise<IndexedFileResult[]> {
  const results: IndexedFileResult[] = []
  for (const file of files) {
    const sourceId = sourceIdForPath(file)
    const cacheFile = path.join(storage, `${sourceId}.json`)
    const previous = await loadJsonlIndex<T>(cacheFile)
    try {
      const refresh = await refreshJsonlIndex(file, previous, indexOptions)
      await saveJsonlIndex(cacheFile, refresh.state)
      results.push({
        chats: summarize(file, refresh.state),
        sourceId,
        sourcePath: toHomeRelative(file),
        mode: refresh.mode,
        appendedRecords: refresh.appendedRecords,
        parserVersion: refresh.state.parserVersion,
        diagnostics: refresh.state.diagnostics,
      })
    } catch (error) {
      if (indexOptions.signal?.aborted) throw error
      if (previous) {
        results.push({
          chats: summarize(file, previous),
          sourceId,
          sourcePath: toHomeRelative(file),
          mode: 'stale',
          appendedRecords: 0,
          parserVersion: previous.parserVersion,
          diagnostics: previous.diagnostics,
          warning: errorMessage(error),
        })
      } else {
        results.push({
          chats: [],
          sourceId,
          sourcePath: toHomeRelative(file),
          mode: 'stale',
          appendedRecords: 0,
          parserVersion: indexOptions.parserVersion,
          diagnostics: failedDiagnostics(error),
          warning: errorMessage(error),
        })
      }
    }
  }
  return results
}

async function removeStaleCaches(storage: string, activeSourceIds: Set<string>): Promise<void> {
  const cacheFiles = await findJsonFiles(storage)
  await Promise.all(
    cacheFiles
      .filter((file) => !activeSourceIds.has(path.basename(file, '.json')))
      .map((file) => rm(file, { force: true })),
  )
}

async function findJsonFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(root, entry.name))
  } catch {
    return []
  }
}

function statsFrom(diagnostics: ParserDiagnostics): JsonlReadStats {
  return {
    recordsRead: diagnostics.recordsRead,
    invalidRecords: diagnostics.invalidJsonLines + diagnostics.unsupportedRecords,
  }
}

async function pathExists(input: string): Promise<boolean> {
  try {
    await stat(input)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

function sourceNote(sourceExists: boolean, fileCount: number, directWarning: string | undefined): string | undefined {
  const notes: string[] = []
  if (sourceExists && fileCount === 0) notes.push('No supported JSONL files found.')
  if (directWarning) notes.push(directWarning)
  return notes.length > 0 ? notes.join(' ') : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failedDiagnostics(error: unknown): ParserDiagnostics {
  return {
    recordsRead: 0,
    recordsUsed: 0,
    recordsIgnored: 0,
    invalidJsonLines: 0,
    unsupportedRecords: 0,
    partialLinePending: false,
    warnings: [errorMessage(error)],
    confidence: 'low',
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
  )
}
