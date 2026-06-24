import { createHash } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sourceIdForPath } from '../chat-identity.js'
import { isObject } from '../jsonl.js'

export interface ParserDiagnostics {
  recordsRead: number
  recordsUsed: number
  recordsIgnored: number
  invalidJsonLines: number
  unsupportedRecords: number
  partialLinePending: boolean
  warnings: string[]
  confidence: 'high' | 'medium' | 'low'
}

export interface IndexedJsonlFile<T> {
  schemaVersion: 1
  canonicalPath: string
  sourceId: string
  size: number
  mtimeMs: number
  byteOffset: number
  fileIdentity?: string
  prefixLength: number
  prefixHash: string
  parserVersion: number
  records: T[]
  diagnostics: ParserDiagnostics
}

/** Upper bound on bytes read per refresh, guarding the extension host against oversized sources. */
export const DEFAULT_MAX_SOURCE_BYTES = 128 * 1024 * 1024

export interface JsonlIndexOptions<T> {
  parserVersion: number
  project: (record: Record<string, unknown>) => T | undefined
  signal?: AbortSignal
  /** Maximum unread bytes to ingest in a single refresh. Defaults to {@link DEFAULT_MAX_SOURCE_BYTES}. */
  maxSourceBytes?: number
}

export interface JsonlIndexRefresh<T> {
  state: IndexedJsonlFile<T>
  mode: 'unchanged' | 'append' | 'rebuild'
  appendedRecords: number
}

export async function refreshJsonlIndex<T>(
  file: string,
  previous: IndexedJsonlFile<T> | undefined,
  options: JsonlIndexOptions<T>,
): Promise<JsonlIndexRefresh<T>> {
  throwIfAborted(options.signal)
  const canonicalPath = path.normalize(path.resolve(file))
  const info = await stat(canonicalPath)
  if (!info.isFile()) throw new Error(`JSONL source is not a file: ${canonicalPath}`)

  const prefixLength =
    previous?.canonicalPath === canonicalPath && previous.parserVersion === options.parserVersion
      ? previous.prefixLength
      : Math.min(info.size, 4096)
  const observedPrefixHash = await hashPrefix(canonicalPath, prefixLength)
  const fileIdentity = fileIdentityFor(info)
  const rebuild =
    !previous ||
    previous.schemaVersion !== 1 ||
    previous.parserVersion !== options.parserVersion ||
    previous.canonicalPath !== canonicalPath ||
    previous.byteOffset > info.size ||
    (previous.byteOffset === previous.size && previous.size === info.size && previous.mtimeMs !== info.mtimeMs) ||
    previous.prefixHash !== observedPrefixHash ||
    Boolean(previous.fileIdentity && fileIdentity && previous.fileIdentity !== fileIdentity)

  if (
    !rebuild &&
    previous &&
    previous.size === info.size &&
    previous.mtimeMs === info.mtimeMs &&
    previous.byteOffset === info.size
  ) {
    return { state: previous, mode: 'unchanged', appendedRecords: 0 }
  }

  const baseRecords = rebuild ? [] : (previous?.records ?? [])
  const baseDiagnostics = rebuild ? emptyDiagnostics() : (previous?.diagnostics ?? emptyDiagnostics())
  const start = rebuild ? 0 : (previous?.byteOffset ?? 0)
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  if (info.size - start > maxSourceBytes) {
    throw new Error(
      `JSONL source exceeds the indexing limit: ${info.size - start} unread bytes exceed ${maxSourceBytes}.`,
    )
  }
  const appended = await readCompleteLines(canonicalPath, start, options)
  const storedPrefixLength = rebuild ? Math.min(info.size, 4096) : prefixLength
  const storedPrefixHash =
    storedPrefixLength === prefixLength ? observedPrefixHash : await hashPrefix(canonicalPath, storedPrefixLength)
  const diagnostics: ParserDiagnostics = {
    recordsRead: baseDiagnostics.recordsRead + appended.diagnostics.recordsRead,
    recordsUsed: baseDiagnostics.recordsUsed + appended.diagnostics.recordsUsed,
    recordsIgnored: baseDiagnostics.recordsIgnored + appended.diagnostics.recordsIgnored,
    invalidJsonLines: baseDiagnostics.invalidJsonLines + appended.diagnostics.invalidJsonLines,
    unsupportedRecords: baseDiagnostics.unsupportedRecords + appended.diagnostics.unsupportedRecords,
    partialLinePending: appended.partialLinePending,
    warnings: uniqueStrings([
      ...baseDiagnostics.warnings.filter((warning) => warning !== 'A trailing partial JSONL line is pending.'),
      ...appended.diagnostics.warnings,
    ]),
    confidence:
      baseDiagnostics.confidence === 'low' || appended.diagnostics.confidence === 'low'
        ? 'low'
        : baseDiagnostics.confidence === 'medium' || appended.diagnostics.confidence === 'medium'
          ? 'medium'
          : 'high',
  }
  const state: IndexedJsonlFile<T> = {
    schemaVersion: 1,
    canonicalPath,
    sourceId: sourceIdForPath(canonicalPath),
    size: info.size,
    mtimeMs: info.mtimeMs,
    byteOffset: appended.byteOffset,
    fileIdentity,
    prefixLength: storedPrefixLength,
    prefixHash: storedPrefixHash,
    parserVersion: options.parserVersion,
    records: [...baseRecords, ...appended.records],
    diagnostics,
  }
  return {
    state,
    mode: rebuild ? 'rebuild' : 'append',
    appendedRecords: appended.records.length,
  }
}

export async function loadJsonlIndex<T>(file: string): Promise<IndexedJsonlFile<T> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return isIndexedJsonlFile<T>(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function saveJsonlIndex<T>(file: string, state: IndexedJsonlFile<T>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

function isIndexedJsonlFile<T>(value: unknown): value is IndexedJsonlFile<T> {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    typeof value.canonicalPath === 'string' &&
    typeof value.byteOffset === 'number' &&
    typeof value.prefixLength === 'number' &&
    typeof value.prefixHash === 'string' &&
    Array.isArray(value.records) &&
    isObject(value.diagnostics)
  )
}

async function readCompleteLines<T>(
  file: string,
  start: number,
  options: JsonlIndexOptions<T>,
): Promise<{
  records: T[]
  byteOffset: number
  partialLinePending: boolean
  diagnostics: ParserDiagnostics
}> {
  const chunks: Buffer[] = []
  const stream = createReadStream(file, { start, signal: options.signal })
  for await (const chunk of stream) {
    throwIfAborted(options.signal)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const buffer = Buffer.concat(chunks)
  const finalNewline = buffer.lastIndexOf(0x0a)
  const completeBytes = finalNewline >= 0 ? buffer.subarray(0, finalNewline + 1) : Buffer.alloc(0)
  const partialLinePending = finalNewline < buffer.length - 1
  const diagnostics = emptyDiagnostics()
  diagnostics.partialLinePending = partialLinePending
  if (partialLinePending) diagnostics.warnings.push('A trailing partial JSONL line is pending.')

  const records: T[] = []
  const lines = completeBytes.toString('utf8').split('\n')
  for (const rawLine of lines) {
    throwIfAborted(options.signal)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.trim()) continue
    diagnostics.recordsRead += 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      diagnostics.invalidJsonLines += 1
      diagnostics.confidence = 'medium'
      continue
    }
    if (!isObject(parsed)) {
      diagnostics.unsupportedRecords += 1
      diagnostics.confidence = 'medium'
      continue
    }
    const projected = options.project(parsed)
    if (projected === undefined) {
      diagnostics.recordsIgnored += 1
      continue
    }
    records.push(projected)
    diagnostics.recordsUsed += 1
  }

  return {
    records,
    byteOffset: start + completeBytes.length,
    partialLinePending,
    diagnostics,
  }
}

function emptyDiagnostics(): ParserDiagnostics {
  return {
    recordsRead: 0,
    recordsUsed: 0,
    recordsIgnored: 0,
    invalidJsonLines: 0,
    unsupportedRecords: 0,
    partialLinePending: false,
    warnings: [],
    confidence: 'high',
  }
}

async function hashPrefix(file: string, length: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
  } finally {
    await handle.close()
  }
}

function fileIdentityFor(info: Stats): string | undefined {
  const dev = Number(info.dev)
  const ino = Number(info.ino)
  return Number.isFinite(dev) && Number.isFinite(ino) && ino > 0 ? `${dev}:${ino}` : undefined
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.')
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}
