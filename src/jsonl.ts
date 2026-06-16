import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

export interface JsonlReadStats {
  recordsRead: number
  invalidRecords: number
}

export async function readJsonl(
  file: string,
  onRecord: (record: Record<string, unknown>) => void,
): Promise<JsonlReadStats> {
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  const stats: JsonlReadStats = { recordsRead: 0, invalidRecords: 0 }

  for await (const line of lines) {
    if (!line.trim()) continue
    stats.recordsRead += 1
    try {
      const parsed: unknown = JSON.parse(line)
      if (isObject(parsed)) onRecord(parsed)
      else stats.invalidRecords += 1
    } catch {
      stats.invalidRecords += 1
    }
  }

  return stats
}

export async function findJsonlFiles(root: string): Promise<string[]> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(root)
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }

  if (info.isFile()) return root.endsWith('.jsonl') ? [root] : []
  if (!info.isDirectory()) return []

  const files: string[] = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const child = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await findJsonlFiles(child)))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child)
  }
  return files.sort()
}

export function objectValue(value: unknown, key?: string): Record<string, unknown> | undefined {
  const next = key && isObject(value) ? value[key] : value
  return isObject(next) ? next : undefined
}

export function stringValue(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined
  const next = value[key]
  return typeof next === 'string' ? next : undefined
}

export function numberValue(value: unknown, key: string): number | undefined {
  if (!isObject(value)) return undefined
  const next = value[key]
  if (typeof next === 'number' && Number.isFinite(next)) return next
  if (typeof next === 'string' && next.trim() !== '') {
    const parsed = Number(next)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
  )
}
