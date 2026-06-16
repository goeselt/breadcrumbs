import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readChatDetail } from './chat-detail.js'
import { readClaudeChatMetadata } from './claude.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('chat detail reports', () => {
  it('suppresses Codex content by default while preserving structure and sizes', async () => {
    const root = await fixtureDirectory()
    await writeJsonl(path.join(root, 'codex.jsonl'), codexRecords())

    const report = await readChatDetail('codex', 'codex-chat', {}, { codexRoot: root })

    expect(report.found).toBe(true)
    expect(report.privacy.contentEmitted).toBe(false)
    expect(report.summary?.contentCharsObserved).toBeGreaterThan(0)
    expect(report.timeline.find((event) => event.kind === 'user_message')?.content).toMatchObject({
      originalChars: 11,
      emittedChars: 0,
    })
    expect(report.timeline.find((event) => event.kind === 'tool_call')).toMatchObject({
      toolName: 'exec_command',
      details: { argumentKeys: ['cmd'] },
    })
  })

  it('separates message and all-content modes', async () => {
    const root = await fixtureDirectory()
    await writeJsonl(path.join(root, 'codex.jsonl'), codexRecords())

    const messages = await readChatDetail(
      'codex',
      'codex-chat',
      { contentMode: 'messages', maxContentChars: 5 },
      { codexRoot: root },
    )
    const all = await readChatDetail(
      'codex',
      'codex-chat',
      { contentMode: 'all', maxContentChars: 100 },
      { codexRoot: root },
    )
    const tools = await readChatDetail(
      'codex',
      'codex-chat',
      { contentMode: 'tools', maxContentChars: 100 },
      { codexRoot: root },
    )

    expect(messages.timeline.find((event) => event.kind === 'user_message')?.content).toMatchObject({
      text: 'hello',
      truncated: true,
    })
    expect(messages.timeline.find((event) => event.kind === 'tool_call')?.content?.text).toBeUndefined()
    expect(tools.timeline.find((event) => event.kind === 'user_message')?.content?.text).toBeUndefined()
    expect(tools.timeline.find((event) => event.kind === 'tool_call')?.content?.text).toContain('echo hi')
    expect(tools.timeline.find((event) => event.kind === 'tool_result')).toMatchObject({
      details: {
        exitCode: 1,
        originalTokenCount: 7,
        chunkId: 'fixture',
      },
    })
    expect(tools.timeline.find((event) => event.kind === 'tool_result')?.content?.text).toContain('failure output')
    expect(tools.context.find((entry) => entry.kind === 'base_instructions')?.content?.text).toBeUndefined()
    expect(all.timeline.find((event) => event.kind === 'tool_call')?.content?.text).toContain('echo hi')
    expect(all.context.find((entry) => entry.kind === 'base_instructions')?.content?.text).toBe('base rules')
  })

  it('keeps Claude streamed content blocks but emits one usage request per message ID', async () => {
    const root = await fixtureDirectory()
    await writeJsonl(path.join(root, 'claude.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'claude-chat',
        uuid: 'user-1',
        cwd: '/workspace',
        message: { role: 'user', content: 'hello claude' },
      },
      claudeAssistant('2026-01-01T00:00:01.000Z', 'assistant-1', { type: 'text', text: 'working' }),
      claudeAssistant('2026-01-01T00:00:02.000Z', 'assistant-2', {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Agent',
        input: {
          description: 'sensitive delegated task',
          prompt: 'sensitive delegated prompt',
          subagent_type: 'Explore',
        },
      }),
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:03.000Z',
        sessionId: 'claude-chat',
        uuid: 'tool-result-1',
        sourceToolAssistantUUID: 'assistant-2',
        cwd: '/workspace',
        toolUseResult: {
          agentId: 'agent-123',
          agentType: 'Explore',
          status: 'completed',
          totalDurationMs: 1200,
          totalTokens: 3400,
          totalToolUseCount: 5,
          content: 'sensitive result',
        },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'sensitive result' }],
        },
      },
    ])

    const report = await readChatDetail('claude', 'claude-chat', { contentMode: 'all' }, { claudeRoot: root })

    expect(report.timeline.filter((event) => event.kind === 'model_request')).toHaveLength(1)
    expect(report.timeline.find((event) => event.kind === 'assistant_message')?.content?.text).toBe('working')
    expect(report.timeline.find((event) => event.kind === 'tool_call')).toMatchObject({
      toolName: 'Agent',
      toolCallId: 'tool-1',
      details: {
        subagentType: 'Explore',
      },
    })
    expect(report.timeline.find((event) => event.kind === 'tool_result')).toMatchObject({
      toolCallId: 'tool-1',
      details: {
        agentId: 'agent-123',
        agentType: 'Explore',
        status: 'completed',
        totalDurationMs: 1200,
        totalTokens: 3400,
        totalToolUseCount: 5,
      },
    })
  })

  it('reports that Copilot content is unavailable when capture attributes are absent', async () => {
    const file = await fixtureFile('copilot.jsonl', [
      copilotRecord(1, 'copilot_chat.session.start', { 'session.id': 'copilot-chat' }),
      copilotRecord(2, 'gen_ai.client.inference.operation.details', {
        'gen_ai.response.model': 'model-a',
        'gen_ai.response.id': 'response-1',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 2,
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

    const report = await readChatDetail('copilot', 'copilot-chat', { contentMode: 'all' }, { copilotFile: file })

    expect(report.found).toBe(true)
    expect(report.privacy.contentEmitted).toBe(false)
    expect(report.metadata?.requests).toBe(1)
    expect(report.timeline.filter((event) => event.kind === 'model_request')).toHaveLength(1)
    expect(report.context).toContainEqual(
      expect.objectContaining({
        kind: 'content_capture',
        details: expect.objectContaining({ available: false }),
      }),
    )
  })

  it('keeps captured Copilot messages hidden in tools-only mode', async () => {
    const file = await fixtureFile('copilot-tools.jsonl', [
      copilotRecord(1, 'copilot_chat.session.start', { 'session.id': 'copilot-tools' }),
      copilotRecord(2, 'gen_ai.client.inference.operation.details', {
        'gen_ai.response.model': 'model-a',
        'gen_ai.response.id': 'response-1',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 2,
        'gen_ai.input.messages': 'sensitive captured prompt',
        'gen_ai.output.messages': 'sensitive captured response',
      }),
      copilotRecord(3, 'copilot_chat.tool.call', {
        'gen_ai.tool.name': 'terminal',
        'github.copilot.tool.parameters.command': 'npm test',
        success: true,
      }),
    ])

    const report = await readChatDetail('copilot', 'copilot-tools', { contentMode: 'tools' }, { copilotFile: file })

    expect(report.timeline.find((event) => event.kind === 'user_message')?.content?.text).toBeUndefined()
    expect(report.timeline.find((event) => event.kind === 'assistant_message')?.content?.text).toBeUndefined()
    expect(report.timeline.find((event) => event.kind === 'tool_call')?.content?.text).toBe('npm test')
  })

  it('requires chatKey when a Claude provider chat ID identifies both a main chat and a subagent', async () => {
    const root = await fixtureDirectory()
    const project = path.join(root, 'project')
    await writeJsonl(path.join(project, 'claude-chat.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'claude-chat',
        cwd: '/workspace',
        message: { role: 'user', content: 'main' },
      },
      claudeAssistant('2026-01-01T00:00:00.500Z', 'main-assistant', { type: 'text', text: 'done' }),
    ])
    await writeJsonl(path.join(project, 'claude-chat', 'subagents', 'agent-a.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 'claude-chat',
        cwd: '/workspace',
        message: { role: 'user', content: 'child' },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.500Z',
        sessionId: 'claude-chat',
        uuid: 'child-assistant',
        cwd: '/workspace',
        message: {
          id: 'message-child',
          role: 'assistant',
          model: 'model-a',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 2,
            output_tokens: 3,
          },
        },
      },
    ])

    const ambiguous = await readChatDetail('claude', 'claude-chat', {}, { claudeRoot: root })
    expect(ambiguous.found).toBe(false)
    expect(ambiguous.note).toContain('ambiguous')

    const metadata = await readClaudeChatMetadata(root)
    const main = metadata.chats.find((chat) => chat.kind === 'main')!
    const detail = await readChatDetail('claude', main.chatKey, {}, { claudeRoot: root })
    expect(detail.found).toBe(true)
    expect(detail.chatKey).toBe(main.chatKey)
    expect(detail.source?.path).toContain('claude-chat.jsonl')
    expect(detail.source?.path).not.toContain('subagents')
  })
})

function codexRecords(): unknown[] {
  return [
    {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'codex-chat',
        model_provider: 'openai',
        cwd: '/workspace',
        base_instructions: 'base rules',
      },
    },
    {
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', model: 'model-a', cwd: '/workspace' },
    },
    {
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'hello world' },
    },
    {
      timestamp: '2026-01-01T00:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{"cmd":"echo hi"}' },
    },
    {
      timestamp: '2026-01-01T00:00:03.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Chunk ID: fixture\nProcess exited with code 1\nOriginal token count: 7\nOutput:\nfailure output',
      },
    },
    {
      timestamp: '2026-01-01T00:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
          },
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
          },
        },
      },
    },
  ]
}

function claudeAssistant(timestamp: string, uuid: string, content: Record<string, unknown>) {
  return {
    type: 'assistant',
    timestamp,
    sessionId: 'claude-chat',
    uuid,
    requestId: 'request-1',
    cwd: '/workspace',
    message: {
      id: 'message-1',
      role: 'assistant',
      model: 'model-a',
      content: [content],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2,
        output_tokens: 3,
      },
    },
  }
}

function copilotRecord(seconds: number, eventName: string, attributes: Record<string, unknown>) {
  return {
    hrTime: [seconds, 0],
    spanContext: { traceId: 'trace-1' },
    attributes: { 'event.name': eventName, ...attributes },
  }
}

async function fixtureFile(name: string, records: unknown[]): Promise<string> {
  const directory = await fixtureDirectory()
  const file = path.join(directory, name)
  await writeJsonl(file, records)
  return file
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'breadcrumbs-detail-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeJsonl(file: string, records: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}
