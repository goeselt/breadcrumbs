import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readCopilotTraceDetail, readCopilotTraceMetadata } from './copilot-traces.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Copilot agent trace database adapter', () => {
  it('uses child chat spans for usage and preserves structured tool details', async () => {
    const databaseFile = await traceDatabaseFixture()
    const report = await readCopilotTraceMetadata(databaseFile)

    expect(report.source.path).toContain('agent-traces.db')
    expect(report.index?.files[0].sourceFormat).toBe('copilot-agent-traces-sqlite')
    expect(report.chats).toHaveLength(1)
    expect(report.chats[0]).toMatchObject({
      providerChatId: 'chat-1',
      title: 'Please inspect this repository',
      requests: 1,
      turns: 1,
      tokens: {
        inputTokens: 100,
        cachedInputTokens: 80,
        outputTokens: 10,
        totalTokens: 110,
      },
      tools: {
        calls: 1,
      },
    })

    const detail = await readCopilotTraceDetail(report.chats[0], {
      contentMode: 'all',
      maxContentChars: 1_000,
    })
    expect(detail.timeline.find((event) => event.kind === 'user_message')?.content?.text).toBe(
      'Please inspect this repository',
    )
    expect(detail.timeline.find((event) => event.kind === 'reasoning')?.content?.text).toBe(
      'I should inspect the files.',
    )
    expect(detail.timeline.find((event) => event.kind === 'tool_call')).toMatchObject({
      parentId: 'model-1',
      toolName: 'read_file',
      toolCallId: 'call-1',
      content: { text: '{"filePath":"/workspace/a.ts"}' },
    })
    expect(detail.timeline.find((event) => event.kind === 'tool_result')).toMatchObject({
      parentId: 'tool-1',
      toolCallId: 'call-1',
      content: { text: 'const value = 1' },
    })
  })

  it('rejects trace databases with missing expected columns', async () => {
    const databaseFile = await malformedTraceDatabaseFixture()

    await expect(readCopilotTraceMetadata(databaseFile)).rejects.toThrow(
      /Unsupported Copilot agent trace database schema\. Missing: spans\.chat_session_id/,
    )
  })
})

async function traceDatabaseFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'breadcrumbs-copilot-traces-'))
  temporaryDirectories.push(directory)
  const databaseFile = path.join(directory, 'agent-traces.db')
  const database = new DatabaseSync(databaseFile)
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
      chat_session_id TEXT,
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
  const insertSpan = database.prepare(`
    INSERT INTO spans (
      span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms, status_code,
      operation_name, provider_name, agent_name, conversation_id, request_model, response_model,
      input_tokens, output_tokens, cached_tokens, reasoning_tokens, tool_name, tool_call_id,
      tool_type, chat_session_id, ttft_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insertSpan.run(
    'root-1',
    'trace-1',
    null,
    'invoke_agent GitHub Copilot Chat',
    1_000,
    5_000,
    1,
    'invoke_agent',
    'github',
    'GitHub Copilot Chat',
    'chat-1',
    'model-a',
    'model-a',
    1_000,
    100,
    900,
    null,
    null,
    null,
    null,
    'chat-1',
    null,
  )
  insertSpan.run(
    'model-1',
    'trace-1',
    'root-1',
    'chat model-a',
    1_200,
    2_000,
    1,
    'chat',
    'github',
    'GitHub Copilot Chat',
    'chat-1',
    'model-a',
    'model-a',
    100,
    10,
    80,
    null,
    null,
    null,
    null,
    'chat-1',
    50,
  )
  insertSpan.run(
    'tool-1',
    'trace-1',
    'root-1',
    'execute_tool read_file',
    2_100,
    2_300,
    1,
    'execute_tool',
    'github',
    'GitHub Copilot Chat',
    'chat-1',
    null,
    null,
    null,
    null,
    null,
    null,
    'read_file',
    'call-1',
    'function',
    'chat-1',
    null,
  )
  database
    .prepare(
      `
    INSERT INTO span_events (span_id, name, timestamp_ms, attributes) VALUES (?, ?, ?, ?)
  `,
    )
    .run('root-1', 'user_message', 1_010, JSON.stringify({ content: 'Please inspect this repository' }))
  database
    .prepare(
      `
    INSERT INTO span_events (span_id, name, timestamp_ms, attributes) VALUES (?, ?, ?, ?)
  `,
    )
    .run('root-1', 'turn_start', 1_020, JSON.stringify({ turnId: '0' }))
  const insertAttribute = database.prepare(`
    INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)
  `)
  insertAttribute.run('model-1', 'copilot_chat.reasoning_content', 'I should inspect the files.')
  insertAttribute.run(
    'model-1',
    'gen_ai.output.messages',
    JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'I found the relevant file.' }] }]),
  )
  insertAttribute.run('tool-1', 'gen_ai.tool.call.arguments', '{"filePath":"/workspace/a.ts"}')
  insertAttribute.run('tool-1', 'gen_ai.tool.call.result', 'const value = 1')
  database.close()
  return databaseFile
}

async function malformedTraceDatabaseFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'breadcrumbs-copilot-traces-malformed-'))
  temporaryDirectories.push(directory)
  const databaseFile = path.join(directory, 'agent-traces.db')
  const database = new DatabaseSync(databaseFile)
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
  return databaseFile
}
