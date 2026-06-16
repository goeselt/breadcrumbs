import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readClaudeChatMetadata } from './claude.js'
import { readCodexChatMetadata } from './codex.js'
import { readCopilotChatMetadata } from './copilot.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('chat metadata adapters', () => {
  it('does not double-count Copilot agent turn usage', async () => {
    const file = await fixtureFile('copilot.jsonl', [
      copilotRecord(1, 'copilot_chat.session.start', { 'session.id': 'session-1' }),
      copilotRecord(2, 'gen_ai.client.inference.operation.details', {
        'gen_ai.response.model': 'model-a',
        'gen_ai.response.id': 'response-1',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 10,
      }),
      copilotRecord(3, 'copilot_chat.agent.turn', {
        'turn.index': 0,
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 10,
      }),
      {
        ...copilotRecord(100, 'gen_ai.client.inference.operation.details', {
          'gen_ai.response.model': 'unrelated-model',
          'gen_ai.response.id': 'unrelated-response',
          'gen_ai.usage.input_tokens': 1000,
          'gen_ai.usage.output_tokens': 1000,
        }),
        spanContext: null,
      },
    ])

    const report = await readCopilotChatMetadata(file)

    expect(report.chats).toHaveLength(1)
    expect(report.chats[0].requests).toBe(1)
    expect(report.chats[0].tokens.totalTokens).toBe(110)
    expect(report.chats[0].turns).toBe(1)
  })

  it('uses Codex cumulative totals and assigns their deltas to the active model', async () => {
    const root = await fixtureDirectory()
    await writeJsonl(path.join(root, 'session.jsonl'), [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-1', model_provider: 'openai', cwd: '/workspace' },
      },
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'model-a' },
      },
      codexUsageRecord('2026-01-01T00:00:02.000Z', 10, 2),
      codexUsageRecord('2026-01-01T00:00:03.000Z', 25, 5),
    ])

    const report = await readCodexChatMetadata(root)

    expect(report.chats[0].tokens.totalTokens).toBe(30)
    expect(report.chats[0].models[0]).toMatchObject({
      model: 'model-a',
      requests: 2,
      totalTokens: 30,
    })
  })

  it('adds Codex thread titles from the read-only state database', async () => {
    const directory = await fixtureDirectory()
    const root = path.join(directory, 'sessions')
    await writeJsonl(path.join(root, 'session.jsonl'), [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-titled', cwd: '/workspace' },
      },
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'model-a' },
      },
      codexUsageRecord('2026-01-01T00:00:02.000Z', 10, 2),
    ])
    const database = new DatabaseSync(path.join(directory, 'state_5.sqlite'))
    database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
    database
      .prepare('INSERT INTO threads (id, title) VALUES (?, ?)')
      .run('codex-titled', '  Improve   the report table  ')
    database.close()

    const report = await readCodexChatMetadata(root)

    expect(report.chats[0].title).toBe('Improve the report table')
  })

  it('continues accumulating when a Codex cumulative counter resets', async () => {
    const root = await fixtureDirectory()
    await writeJsonl(path.join(root, 'session.jsonl'), [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-reset', cwd: '/workspace' },
      },
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'model-a' },
      },
      codexUsageRecord('2026-01-01T00:00:02.000Z', 100, 10),
      codexUsageRecord('2026-01-01T00:00:03.000Z', 20, 2),
      codexUsageRecord('2026-01-01T00:00:04.000Z', 30, 3),
    ])

    const report = await readCodexChatMetadata(root)

    expect(report.chats[0].tokens.totalTokens).toBe(143)
    expect(report.chats[0].models[0]).toMatchObject({
      requests: 3,
      totalTokens: 143,
    })
  })

  it('collapses Claude streaming snapshots by message ID and keeps the latest usage', async () => {
    const root = await fixtureDirectory()
    await writeJsonl(path.join(root, 'session.jsonl'), [
      claudeRecord('2026-01-01T00:00:00.000Z', 'message-1', 10, 2),
      claudeRecord('2026-01-01T00:00:01.000Z', 'message-1', 12, 3),
      claudeRecord('2026-01-01T00:00:02.000Z', 'message-2', 20, 4),
    ])

    const report = await readClaudeChatMetadata(root)

    expect(report.chats[0].requests).toBe(2)
    expect(report.chats[0].tokens).toMatchObject({
      inputTokens: 32,
      outputTokens: 7,
      totalTokens: 39,
    })
  })

  it('keeps Claude generated titles and removes sessions without requests', async () => {
    const root = await fixtureDirectory()
    await writeJsonl(path.join(root, 'titled.jsonl'), [
      { type: 'ai-title', sessionId: 'claude-1', aiTitle: 'Review CI failures' },
      claudeRecord('2026-01-01T00:00:00.000Z', 'message-1', 10, 2),
    ])
    await writeJsonl(path.join(root, 'empty.jsonl'), [
      { type: 'ai-title', sessionId: 'claude-empty', aiTitle: 'Empty chat' },
    ])

    const report = await readClaudeChatMetadata(root)

    expect(report.chats).toHaveLength(1)
    expect(report.chats[0]).toMatchObject({
      providerChatId: 'claude-1',
      title: 'Review CI failures',
      requests: 1,
    })
  })

  it('removes Copilot sessions without inference requests', async () => {
    const file = await fixtureFile('copilot-empty.jsonl', [
      copilotRecord(1, 'copilot_chat.session.start', { 'session.id': 'empty-session' }),
      copilotRecord(2, 'copilot_chat.agent.turn', { 'turn.index': 0 }),
    ])

    const report = await readCopilotChatMetadata(file)

    expect(report.chats).toEqual([])
    expect(report.totals.chats).toBe(0)
  })

  it('uses Claude timestamps instead of file order for the observed chat range', async () => {
    const root = await fixtureDirectory()
    await writeJsonl(path.join(root, 'session.jsonl'), [
      claudeRecord('2026-01-01T00:00:02.000Z', 'message-2', 20, 4),
      claudeRecord('2026-01-01T00:00:00.000Z', 'message-1', 10, 2),
    ])

    const report = await readClaudeChatMetadata(root)

    expect(report.chats[0]).toMatchObject({
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:02.000Z',
    })
  })

  it('gives Claude main chats and subagents distinct keys without double-counting default totals', async () => {
    const root = await fixtureDirectory()
    const project = path.join(root, 'project')
    const mainFile = path.join(project, 'claude-1.jsonl')
    const subagentFile = path.join(project, 'claude-1', 'subagents', 'agent-a.jsonl')
    await writeJsonl(mainFile, [claudeRecord('2026-01-01T00:00:00.000Z', 'main-message', 10, 2)])
    await writeJsonl(subagentFile, [claudeRecord('2026-01-01T00:00:01.000Z', 'subagent-message', 20, 4)])

    const report = await readClaudeChatMetadata(root)
    const main = report.chats.find((chat) => chat.kind === 'main')
    const subagent = report.chats.find((chat) => chat.kind === 'subagent')

    expect(main?.chatKey).not.toBe(subagent?.chatKey)
    expect(subagent?.parentChatKey).toBe(main?.chatKey)
    expect(report.totals).toMatchObject({ chats: 1, requests: 1 })
    expect(report.totalsIncludingChildren).toMatchObject({ chats: 2, requests: 2 })
  })
})

function copilotRecord(seconds: number, eventName: string, attributes: Record<string, unknown>) {
  return {
    hrTime: [seconds, 0],
    spanContext: { traceId: 'trace-1' },
    attributes: { 'event.name': eventName, ...attributes },
  }
}

function codexUsageRecord(timestamp: string, inputTokens: number, outputTokens: number) {
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

function claudeRecord(timestamp: string, messageId: string, inputTokens: number, outputTokens: number) {
  return {
    timestamp,
    sessionId: 'claude-1',
    cwd: '/workspace',
    message: {
      id: messageId,
      model: 'model-a',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }
}

async function fixtureFile(name: string, records: unknown[]): Promise<string> {
  const directory = await fixtureDirectory()
  const file = path.join(directory, name)
  await writeJsonl(file, records)
  return file
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'breadcrumbs-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeJsonl(file: string, records: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}
