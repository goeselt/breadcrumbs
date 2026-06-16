import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadJsonlIndex, refreshJsonlIndex, saveJsonlIndex } from './jsonl-index.js'

const temporaryDirectories: string[] = []
const options = {
  parserVersion: 1,
  project: (record: Record<string, unknown>) => (typeof record.id === 'string' ? { id: record.id } : undefined),
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('incremental JSONL index', () => {
  it('reads only appended complete lines and leaves a partial line pending', async () => {
    const file = await fixture('source.jsonl', '{"id":"one"}\n{"id":"par')
    const first = await refreshJsonlIndex(file, undefined, options)

    expect(first.mode).toBe('rebuild')
    expect(first.state.records).toEqual([{ id: 'one' }])
    expect(first.state.diagnostics.partialLinePending).toBe(true)

    await appendFile(file, 'tial"}\n')
    const second = await refreshJsonlIndex(file, first.state, options)

    expect(second.mode).toBe('append')
    expect(second.appendedRecords).toBe(1)
    expect(second.state.records).toEqual([{ id: 'one' }, { id: 'partial' }])
    expect(second.state.diagnostics.partialLinePending).toBe(false)
  })

  it('rebuilds after truncation instead of retaining stale records', async () => {
    const file = await fixture('source.jsonl', '{"id":"one"}\n{"id":"two"}\n')
    const first = await refreshJsonlIndex(file, undefined, options)
    await truncate(file, 0)
    await writeFile(file, '{"id":"replacement"}\n')

    const second = await refreshJsonlIndex(file, first.state, options)

    expect(second.mode).toBe('rebuild')
    expect(second.state.records).toEqual([{ id: 'replacement' }])
  })

  it('rebuilds when a fully consumed file is rewritten at the same size', async () => {
    const file = await fixture('source.jsonl', '{"id":"one"}\n')
    const first = await refreshJsonlIndex(file, undefined, options)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await writeFile(file, '{"id":"two"}\n')

    const second = await refreshJsonlIndex(file, first.state, options)

    expect(second.mode).toBe('rebuild')
    expect(second.state.records).toEqual([{ id: 'two' }])
  })

  it('persists and reloads an index atomically', async () => {
    const directory = await fixtureDirectory()
    const source = path.join(directory, 'source.jsonl')
    const cache = path.join(directory, 'cache', 'source.json')
    await writeFile(source, '{"id":"one"}\n')
    const refresh = await refreshJsonlIndex(source, undefined, options)

    await saveJsonlIndex(cache, refresh.state)
    const loaded = await loadJsonlIndex<{ id: string }>(cache)

    expect(loaded).toEqual(refresh.state)
  })

  it('counts malformed, unsupported, and ignored records without stopping', async () => {
    const file = await fixture('source.jsonl', '{"id":"one"}\nnot-json\n[]\n{"unrelated":true}\n')

    const refresh = await refreshJsonlIndex(file, undefined, options)

    expect(refresh.state.records).toEqual([{ id: 'one' }])
    expect(refresh.state.diagnostics).toMatchObject({
      recordsRead: 4,
      recordsUsed: 1,
      recordsIgnored: 1,
      invalidJsonLines: 1,
      unsupportedRecords: 1,
      confidence: 'medium',
    })
  })

  it('can be cancelled before reading', async () => {
    const file = await fixture('source.jsonl', '{"id":"one"}\n')
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    await expect(refreshJsonlIndex(file, undefined, { ...options, signal: controller.signal })).rejects.toThrow(
      'cancelled',
    )
  })
})

async function fixture(name: string, content: string): Promise<string> {
  const directory = await fixtureDirectory()
  const file = path.join(directory, name)
  await writeFile(file, content)
  return file
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'breadcrumbs-index-'))
  temporaryDirectories.push(directory)
  return directory
}
