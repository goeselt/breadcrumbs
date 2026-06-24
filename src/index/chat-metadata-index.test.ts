import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readIndexedChatDetail } from '../adapters/chat-detail.js'
import { SOURCE_FORMATS } from '../adapters/registry.js'
import type { ChatMetadata } from '../chat-metadata.js'
import { readIndexedChatMetadata, refreshIndexedFiles } from './chat-metadata-index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('indexed chat metadata', () => {
  it('increments Codex usage without persisting content-bearing fields', async () => {
    const directory = await fixtureDirectory()
    const sourceRoot = path.join(directory, 'sessions')
    const storageRoot = path.join(directory, 'index')
    const source = path.join(sourceRoot, 'session.jsonl')
    await writeJsonl(source, [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-chat',
          cwd: '/workspace',
          base_instructions: 'DO NOT PERSIST THIS SECRET',
        },
      },
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'model-a' },
      },
      usageRecord('2026-01-01T00:00:02.000Z', 10, 2),
    ])

    const first = await readIndexedChatMetadata('codex', {
      source: sourceRoot,
      storageRoot,
    })

    expect(first.index?.files[0].mode).toBe('rebuild')
    expect(first.chats[0].tokens.totalTokens).toBe(12)
    const cache = path.join(storageRoot, 'schema-1', 'codex', `${first.chats[0].sourceId}.json`)
    expect(await readFile(cache, 'utf8')).not.toContain('DO NOT PERSIST THIS SECRET')
    const summaryCache = path.join(storageRoot, 'schema-1', 'codex', `${first.chats[0].sourceId}.summary.json`)
    expect(await readFile(summaryCache, 'utf8')).not.toContain('DO NOT PERSIST THIS SECRET')

    await appendFile(source, `${JSON.stringify(usageRecord('2026-01-01T00:00:03.000Z', 25, 5))}\n`)
    const second = await readIndexedChatMetadata('codex', {
      source: sourceRoot,
      storageRoot,
    })

    expect(second.index?.files[0]).toMatchObject({ mode: 'append', appendedRecords: 1 })
    expect(second.chats[0].tokens.totalTokens).toBe(30)

    const detail = await readIndexedChatDetail(second.chats[0])
    expect(detail).toMatchObject({
      found: true,
      chatKey: second.chats[0].chatKey,
      providerChatId: 'codex-chat',
    })
    expect(detail.privacy.contentEmitted).toBe(false)
  })

  it('keeps Claude subagents separate and excludes them from default totals', async () => {
    const directory = await fixtureDirectory()
    const sourceRoot = path.join(directory, 'projects')
    const storageRoot = path.join(directory, 'index')
    await writeJsonl(path.join(sourceRoot, 'project', 'claude-chat.jsonl'), [
      { type: 'ai-title', sessionId: 'claude-chat', aiTitle: 'Investigate token usage' },
      claudeRecord('main-message', 10, 2),
    ])
    await writeJsonl(path.join(sourceRoot, 'project', 'claude-chat', 'subagents', 'agent-a.jsonl'), [
      claudeRecord('child-message', 20, 4),
    ])

    const report = await readIndexedChatMetadata('claude', {
      source: sourceRoot,
      storageRoot,
    })

    expect(report.totals).toMatchObject({ chats: 1, requests: 1 })
    expect(report.totalsIncludingChildren).toMatchObject({ chats: 2, requests: 2 })
    const main = report.chats.find((chat) => chat.kind === 'main')
    const child = report.chats.find((chat) => chat.kind === 'subagent')
    expect(main?.title).toBe('Investigate token usage')
    expect(child?.parentChatKey).toBe(main?.chatKey)
  })

  it('removes cached entries after a source file is deleted', async () => {
    const directory = await fixtureDirectory()
    const sourceRoot = path.join(directory, 'sessions')
    const storageRoot = path.join(directory, 'index')
    const source = path.join(sourceRoot, 'session.jsonl')
    await writeJsonl(source, [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'deleted-chat', cwd: '/workspace' },
      },
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'model-a' },
      },
      usageRecord('2026-01-01T00:00:02.000Z', 10, 2),
    ])
    const first = await readIndexedChatMetadata('codex', { source: sourceRoot, storageRoot })
    const cache = path.join(storageRoot, 'schema-1', 'codex', `${first.chats[0].sourceId}.json`)

    await unlink(source)
    const second = await readIndexedChatMetadata('codex', { source: sourceRoot, storageRoot })

    expect(second.chats).toEqual([])
    await expect(readFile(cache, 'utf8')).rejects.toThrow()
  })

  it('keeps healthy files when another file fails during its first parse', async () => {
    const directory = await fixtureDirectory()
    const storageRoot = path.join(directory, 'index')
    const healthy = path.join(directory, 'healthy.jsonl')
    const broken = path.join(directory, 'broken.jsonl')
    await writeFile(healthy, '{"id":"healthy"}\n')
    await writeFile(broken, '{"explode":true}\n')

    const results = await refreshIndexedFiles(
      [healthy, broken],
      storageRoot,
      {
        parserVersion: 1,
        project: (record) => {
          if (record.explode === true) throw new Error('synthetic parser failure')
          return typeof record.id === 'string' ? { id: record.id } : undefined
        },
      },
      (_file, state) => (state.records.length > 0 ? [] : []),
    )

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      mode: 'rebuild',
      diagnostics: { recordsUsed: 1, confidence: 'high' },
    })
    expect(results[1]).toMatchObject({
      mode: 'stale',
      warning: 'synthetic parser failure',
      diagnostics: {
        recordsUsed: 0,
        confidence: 'low',
        warnings: ['synthetic parser failure'],
      },
    })
  })

  it('reuses the cached summary for unchanged files and re-summarizes on change', async () => {
    const directory = await fixtureDirectory()
    const storageRoot = path.join(directory, 'index')
    const source = path.join(directory, 'session.jsonl')
    await writeFile(source, '{"id":"a"}\n')

    let summarizeCalls = 0
    const indexOptions = {
      parserVersion: 1,
      project: (record: Record<string, unknown>) => (typeof record.id === 'string' ? { id: record.id } : undefined),
    }
    const summarize = (_file: string, state: { records: { id: string }[] }) => {
      summarizeCalls += 1
      return state.records.map((record) => ({ id: record.id }) as unknown as ChatMetadata)
    }

    const first = await refreshIndexedFiles([source], storageRoot, indexOptions, summarize)
    expect(first[0].mode).toBe('rebuild')
    expect(summarizeCalls).toBe(1)

    const second = await refreshIndexedFiles([source], storageRoot, indexOptions, summarize)
    expect(second[0].mode).toBe('unchanged')
    expect(summarizeCalls).toBe(1)
    expect(second[0].chats).toEqual(first[0].chats)

    await appendFile(source, '{"id":"b"}\n')
    const third = await refreshIndexedFiles([source], storageRoot, indexOptions, summarize)
    expect(third[0].mode).toBe('append')
    expect(summarizeCalls).toBe(2)
    expect(third[0].chats).toHaveLength(2)
  })

  it('invalidates the cached summary when the parser version changes', async () => {
    const directory = await fixtureDirectory()
    const storageRoot = path.join(directory, 'index')
    const source = path.join(directory, 'session.jsonl')
    await writeFile(source, '{"id":"a"}\n')

    let summarizeCalls = 0
    const project = (record: Record<string, unknown>) => (typeof record.id === 'string' ? { id: record.id } : undefined)
    const summarize = (_file: string, state: { records: { id: string }[] }) => {
      summarizeCalls += 1
      return state.records.map((record) => ({ id: record.id }) as unknown as ChatMetadata)
    }

    await refreshIndexedFiles([source], storageRoot, { parserVersion: 1, project }, summarize)
    const second = await refreshIndexedFiles([source], storageRoot, { parserVersion: 2, project }, summarize)
    expect(second[0].mode).toBe('rebuild')
    expect(summarizeCalls).toBe(2)
  })

  it('falls back to Copilot JSONL when the trace database schema drifts', async () => {
    const directory = await fixtureDirectory()
    const storageRoot = path.join(directory, 'index')
    const traceDatabase = path.join(directory, 'agent-traces.db')
    const source = path.join(directory, 'copilot-otel.jsonl')
    await writeMalformedCopilotTraceDatabase(traceDatabase)
    await writeJsonl(source, [
      copilotOtelRecord('2026-01-01T00:00:00.000Z', 'trace-1', {
        'event.name': 'copilot_chat.session.start',
        'session.id': 'copilot-chat',
      }),
      copilotOtelRecord('2026-01-01T00:00:01.000Z', 'trace-1', {
        'event.name': 'gen_ai.client.inference.operation.details',
        'gen_ai.response.id': 'response-1',
        'gen_ai.response.model': 'model-a',
        'gen_ai.usage.input_tokens': 7,
        'gen_ai.usage.output_tokens': 3,
      }),
    ])

    const report = await readIndexedChatMetadata('copilot', {
      source,
      storageRoot,
      directSources: {
        [SOURCE_FORMATS.copilotTraceSqlite]: traceDatabase,
      },
    })

    expect(report.index?.files[0].sourceFormat).toBe(SOURCE_FORMATS.copilotOtelJsonl)
    expect(report.source.note).toContain('copilot-agent-traces-sqlite could not be read')
    expect(report.chats).toHaveLength(1)
    expect(report.chats[0]).toMatchObject({
      providerChatId: 'copilot-chat',
      requests: 1,
      tokens: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
      },
    })
  })
})

function usageRecord(timestamp: string, inputTokens: number, outputTokens: number) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens + outputTokens,
        },
      },
    },
  }
}

function claudeRecord(messageId: string, inputTokens: number, outputTokens: number) {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    sessionId: 'claude-chat',
    cwd: '/workspace',
    message: {
      id: messageId,
      model: 'model-a',
      content: 'DO NOT PERSIST THIS MESSAGE',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }
}

function copilotOtelRecord(timestamp: string, traceId: string, attributes: Record<string, unknown>) {
  const milliseconds = Date.parse(timestamp)
  return {
    hrTime: [Math.floor(milliseconds / 1000), (milliseconds % 1000) * 1_000_000],
    spanContext: { traceId },
    attributes,
  }
}

async function writeMalformedCopilotTraceDatabase(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const database = new DatabaseSync(file)
  database.exec(`
    CREATE TABLE spans (
      span_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      start_time_ms INTEGER NOT NULL,
      end_time_ms INTEGER NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 0,
      status_message TEXT,
      operation_name TEXT,
      provider_name TEXT,
      agent_name TEXT,
      conversation_id TEXT,
      request_model TEXT,
      response_model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      reasoning_tokens INTEGER,
      tool_name TEXT,
      tool_call_id TEXT,
      tool_type TEXT,
      turn_index INTEGER,
      ttft_ms REAL
    );
    CREATE TABLE span_attributes (
      span_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (span_id, key)
    );
    CREATE TABLE span_events (
      id INTEGER PRIMARY KEY,
      span_id TEXT NOT NULL,
      name TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      attributes TEXT
    );
  `)
  database.close()
}

async function writeJsonl(file: string, records: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'breadcrumbs-metadata-index-'))
  temporaryDirectories.push(directory)
  return directory
}
