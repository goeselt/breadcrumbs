import {
  contentExcerpt,
  emptyChatDetailReport,
  finalizeChatDetailReport,
  resolveChatDetailOptions,
  type ChatContextEntry,
  type ChatDetailEvent,
  type ChatDetailOptions,
  type ChatDetailReport,
} from '../chat-detail.js'
import { resolveChatReference, type ChatMetadata, type TokenUsage } from '../chat-metadata.js'
import { numberValue, objectValue, readJsonl, stringValue } from '../jsonl.js'
import { expandHome, toHomeRelative } from '../path.js'
import { readCopilotChatMetadata } from './copilot.js'

const TOKEN_SEMANTICS = 'input_plus_output; cache_fields_are_reported_separately' as const

interface CopilotDetailRecord {
  timestamp: string
  timestampMs: number
  traceId?: string
  attributes: Record<string, unknown>
}

export async function readCopilotChatDetail(
  chatReference: string,
  inputOptions: ChatDetailOptions = {},
  fileInput = '~/.cache/vscode-chat-token-usage/copilot-otel.jsonl',
  metadataInput?: ChatMetadata,
): Promise<ChatDetailReport> {
  const options = resolveChatDetailOptions(inputOptions)
  const resolution = metadataInput
    ? { chat: metadataInput }
    : resolveChatReference((await readCopilotChatMetadata(fileInput)).chats, chatReference)
  const metadata = resolution.chat
  if (!metadata) {
    return emptyChatDetailReport('copilot', chatReference, options, resolution.note ?? 'Copilot chat not found.')
  }

  const file = expandHome(metadata.sourcePath)
  const records: CopilotDetailRecord[] = []
  const stats = await readJsonl(file, (record) => {
    const normalized = normalizeRecord(record)
    if (normalized) records.push(normalized)
  })
  records.sort((a, b) => a.timestampMs - b.timestampMs)

  const startIndex = records.findIndex(
    (record) =>
      stringValue(record.attributes, 'event.name') === 'copilot_chat.session.start' &&
      stringValue(record.attributes, 'session.id') === metadata.providerChatId,
  )
  if (startIndex < 0) {
    return emptyChatDetailReport('copilot', chatReference, options, 'Copilot session start not found.')
  }

  const start = records[startIndex]
  const tracedEndMs = records
    .filter((record) => record.traceId === start.traceId)
    .reduce((latest, record) => Math.max(latest, record.timestampMs), start.timestampMs)
  const selected = records.filter((record) => {
    if (record.traceId === start.traceId) return true
    return record.traceId === undefined && record.timestampMs >= start.timestampMs && record.timestampMs <= tracedEndMs
  })

  const timeline: ChatDetailEvent[] = []
  const context: ChatContextEntry[] = []
  const inferenceKeys = new Set<string>()
  const toolEvents = new Map<string, ChatDetailEvent>()

  for (const record of selected) {
    const { attributes } = record
    const eventName = stringValue(attributes, 'event.name')
    if (eventName === 'copilot_chat.session.start') {
      timeline.push({
        timestamp: record.timestamp,
        kind: 'session',
        model: stringValue(attributes, 'gen_ai.request.model'),
        details: {
          state: 'started',
          agentName: stringValue(attributes, 'gen_ai.agent.name'),
          traceId: record.traceId,
        },
      })
      continue
    }

    if (eventName === 'gen_ai.client.inference.operation.details') {
      const usage = copilotUsage(attributes)
      const model = stringValue(attributes, 'gen_ai.response.model') ?? stringValue(attributes, 'gen_ai.request.model')
      const responseId = stringValue(attributes, 'gen_ai.response.id')
      const identity = `${record.timestamp}|${responseId}|${model}|${usage.inputTokens}|${usage.outputTokens}`
      if (inferenceKeys.has(identity)) continue
      inferenceKeys.add(identity)
      timeline.push({
        timestamp: record.timestamp,
        kind: 'model_request',
        requestId: responseId,
        model,
        usage,
        details: {
          operation: stringValue(attributes, 'gen_ai.operation.name'),
          finishReasons: attributes['gen_ai.response.finish_reasons'],
          maxTokens: numberValue(attributes, 'gen_ai.request.max_tokens'),
          temperature: numberValue(attributes, 'gen_ai.request.temperature'),
          traced: Boolean(record.traceId),
        },
      })
      addCapturedMessages(record, options, timeline)
      continue
    }

    if (eventName === 'copilot_chat.agent.turn') {
      timeline.push({
        timestamp: record.timestamp,
        kind: 'turn',
        details: {
          turnIndex: numberValue(attributes, 'turn.index'),
          toolCallCount: numberValue(attributes, 'tool_call_count'),
        },
      })
      continue
    }

    if (eventName === 'copilot_chat.tool.call') {
      const toolName = stringValue(attributes, 'gen_ai.tool.name') ?? '(unknown)'
      const identity = `${record.timestamp}|${toolName}`
      const event: ChatDetailEvent = {
        timestamp: record.timestamp,
        kind: 'tool_call',
        toolName,
        durationMs: numberValue(attributes, 'duration_ms'),
        success: booleanValue(attributes, 'success'),
        content: contentExcerpt(
          attributes['gen_ai.tool.call.arguments'] ?? attributes['github.copilot.tool.parameters.command'],
          options.contentMode === 'tools' || options.contentMode === 'all',
          options,
          'Tool arguments require --content tools or --content all and Copilot content capture.',
        ),
        details: {
          filePath:
            options.contentMode === 'tools' || options.contentMode === 'all'
              ? stringValue(attributes, 'github.copilot.tool.parameters.file_path')
              : undefined,
        },
      }
      const previous = toolEvents.get(identity)
      if (!previous || (event.durationMs ?? 0) > (previous.durationMs ?? 0)) toolEvents.set(identity, event)
    }
  }
  timeline.push(...toolEvents.values())

  if (!hasCapturedContent(selected)) {
    context.push({
      kind: 'content_capture',
      label: 'Copilot content capture',
      details: {
        available: false,
        explanation:
          'No input/output message attributes were observed. This is expected when github.copilot.chat.otel.captureContent=false.',
      },
    })
  }

  return finalizeChatDetailReport({
    schemaVersion: 2,
    reportType: 'chat-detail',
    provider: 'copilot',
    chatKey: metadata.chatKey,
    providerChatId: metadata.providerChatId,
    chatId: metadata.chatId,
    generatedAt: new Date().toISOString(),
    found: true,
    source: {
      path: toHomeRelative(file),
      recordsRead: stats.recordsRead,
      invalidRecords: stats.invalidRecords,
    },
    metadata,
    context,
    timeline,
    options,
  })
}

function addCapturedMessages(
  record: CopilotDetailRecord,
  options: ReturnType<typeof resolveChatDetailOptions>,
  timeline: ChatDetailEvent[],
): void {
  const input = record.attributes['gen_ai.input.messages']
  const output = record.attributes['gen_ai.output.messages']
  if (input !== undefined) {
    timeline.push({
      timestamp: record.timestamp,
      kind: 'user_message',
      role: 'input-context',
      content: contentExcerpt(
        input,
        options.contentMode === 'messages' || options.contentMode === 'all',
        options,
        'Captured Copilot input requires --content messages or --content all.',
      ),
    })
  }
  if (output !== undefined) {
    timeline.push({
      timestamp: record.timestamp,
      kind: 'assistant_message',
      role: 'output',
      content: contentExcerpt(
        output,
        options.contentMode === 'messages' || options.contentMode === 'all',
        options,
        'Captured Copilot output requires --content messages or --content all.',
      ),
    })
  }
}

function normalizeRecord(record: Record<string, unknown>): CopilotDetailRecord | undefined {
  const { hrTime } = record
  const attributes = objectValue(record, 'attributes')
  if (!Array.isArray(hrTime) || hrTime.length < 2 || !attributes) return undefined
  const seconds = Number(hrTime[0])
  const nanoseconds = Number(hrTime[1])
  if (!Number.isFinite(seconds) || !Number.isFinite(nanoseconds)) return undefined
  const timestampMs = seconds * 1000 + nanoseconds / 1_000_000
  return {
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    traceId: stringValue(objectValue(record, 'spanContext'), 'traceId'),
    attributes,
  }
}

function copilotUsage(attributes: Record<string, unknown>): TokenUsage {
  const inputTokens = numberValue(attributes, 'gen_ai.usage.input_tokens') ?? 0
  const outputTokens = numberValue(attributes, 'gen_ai.usage.output_tokens') ?? 0
  return {
    inputTokens,
    cachedInputTokens: numberValue(attributes, 'gen_ai.usage.cache_read.input_tokens') ?? 0,
    cacheCreationInputTokens: numberValue(attributes, 'gen_ai.usage.cache_creation.input_tokens') ?? 0,
    outputTokens,
    reasoningOutputTokens: numberValue(attributes, 'gen_ai.usage.reasoning.output_tokens') ?? 0,
    totalTokens: inputTokens + outputTokens,
    totalTokenSemantics: TOKEN_SEMANTICS,
  }
}

function hasCapturedContent(records: CopilotDetailRecord[]): boolean {
  return records.some(
    (record) =>
      record.attributes['gen_ai.input.messages'] !== undefined ||
      record.attributes['gen_ai.output.messages'] !== undefined,
  )
}

function booleanValue(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const next = (value as Record<string, unknown>)[key]
  return typeof next === 'boolean' ? next : undefined
}
