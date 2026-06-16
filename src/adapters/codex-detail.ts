import { homedir } from 'node:os'
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
import { readCodexChatMetadata } from './codex.js'

const TOKEN_SEMANTICS = 'input_plus_output; cached_input_is_a_subset_of_input' as const

export async function readCodexChatDetail(
  chatReference: string,
  inputOptions: ChatDetailOptions = {},
  rootInput = '~/.codex/sessions',
  metadataInput?: ChatMetadata,
): Promise<ChatDetailReport> {
  const options = resolveChatDetailOptions(inputOptions)
  const resolution = metadataInput
    ? { chat: metadataInput }
    : resolveChatReference((await readCodexChatMetadata(rootInput)).chats, chatReference)
  const metadata = resolution.chat
  if (!metadata) {
    return emptyChatDetailReport('codex', chatReference, options, resolution.note ?? 'Codex chat not found.')
  }

  const file = expandHome(metadata.sourcePath, homedir())
  const timeline: ChatDetailEvent[] = []
  const context: ChatContextEntry[] = []
  const contextKeys = new Set<string>()
  let currentModel: string | undefined

  const stats = await readJsonl(file, (record) => {
    const timestamp = stringValue(record, 'timestamp')
    const recordType = stringValue(record, 'type')
    const payload = objectValue(record, 'payload')
    if (!payload) return

    if (recordType === 'session_meta') {
      addContext(context, contextKeys, {
        kind: 'base_instructions',
        label: 'Codex base instructions',
        source: 'session_meta.payload.base_instructions',
        content: contentExcerpt(
          payload.base_instructions,
          options.contentMode === 'all',
          options,
          'Base instructions require --content all.',
        ),
      })
      return
    }

    if (recordType === 'turn_context') {
      currentModel = stringValue(payload, 'model') ?? currentModel
      const turnId = stringValue(payload, 'turn_id')
      timeline.push({
        timestamp,
        kind: 'turn',
        turnId,
        model: currentModel,
        details: {
          cwd: homeRelative(stringValue(payload, 'cwd')),
          workspaceRoots: stringArray(payload.workspace_roots).map(homeRelative),
          currentDate: stringValue(payload, 'current_date'),
          timezone: stringValue(payload, 'timezone'),
          collaborationMode: stringValue(objectValue(payload, 'collaboration_mode'), 'mode'),
          reasoningEffort: stringValue(payload, 'effort'),
        },
      })

      const collaborationSettings = objectValue(objectValue(payload, 'collaboration_mode'), 'settings')
      addContext(context, contextKeys, {
        kind: 'developer_instructions',
        label: 'Turn developer instructions',
        source: 'turn_context.payload.collaboration_mode.settings.developer_instructions',
        content: contentExcerpt(
          collaborationSettings?.developer_instructions,
          options.contentMode === 'all',
          options,
          'Developer instructions require --content all.',
        ),
        details: { turnId },
      })
      return
    }

    if (recordType === 'event_msg') {
      readEventMessage(payload, timestamp, currentModel, options, timeline)
      return
    }

    if (recordType === 'response_item') {
      readResponseItem(payload, timestamp, options, timeline, context, contextKeys)
    }
  })

  return finalizeChatDetailReport({
    schemaVersion: 2,
    reportType: 'chat-detail',
    provider: 'codex',
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

function readEventMessage(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  currentModel: string | undefined,
  options: ReturnType<typeof resolveChatDetailOptions>,
  timeline: ChatDetailEvent[],
): void {
  const type = stringValue(payload, 'type')
  if (type === 'user_message' || type === 'agent_message') {
    timeline.push({
      timestamp,
      kind: type === 'user_message' ? 'user_message' : 'assistant_message',
      role: type === 'user_message' ? 'user' : 'assistant',
      model: type === 'agent_message' ? currentModel : undefined,
      content: contentExcerpt(
        payload.message,
        options.contentMode === 'messages' || options.contentMode === 'all',
        options,
        'Message content requires --content messages or --content all.',
      ),
      details: {
        phase: stringValue(payload, 'phase'),
        imageCount: arrayLength(payload.images) + arrayLength(payload.local_images),
      },
    })
    return
  }

  if (type === 'task_started') {
    timeline.push({
      timestamp,
      kind: 'turn',
      turnId: stringValue(payload, 'turn_id'),
      model: currentModel,
      details: {
        state: 'started',
        modelContextWindow: numberValue(payload, 'model_context_window'),
        collaborationMode: stringValue(payload, 'collaboration_mode_kind'),
      },
    })
    return
  }

  if (type === 'task_complete') {
    timeline.push({
      timestamp,
      kind: 'turn',
      turnId: stringValue(payload, 'turn_id'),
      model: currentModel,
      durationMs: numberValue(payload, 'duration_ms'),
      timeToFirstTokenMs: numberValue(payload, 'time_to_first_token_ms'),
      details: { state: 'completed' },
    })
    return
  }

  if (type === 'token_count') {
    const info = objectValue(payload, 'info')
    const usage = codexUsage(objectValue(info, 'last_token_usage'))
    timeline.push({
      timestamp,
      kind: 'model_request',
      model: currentModel,
      usage,
      details: {
        modelContextWindow: numberValue(info, 'model_context_window'),
      },
    })
    return
  }

  if (type === 'web_search_end') {
    timeline.push({
      timestamp,
      kind: 'tool_result',
      toolName: 'web_search',
      toolCallId: stringValue(payload, 'call_id'),
      content: contentExcerpt(
        payload.query,
        options.contentMode === 'tools' || options.contentMode === 'all',
        options,
        'Search query requires --content tools or --content all.',
      ),
    })
  }
}

function readResponseItem(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  options: ReturnType<typeof resolveChatDetailOptions>,
  timeline: ChatDetailEvent[],
  context: ChatContextEntry[],
  contextKeys: Set<string>,
): void {
  const type = stringValue(payload, 'type')
  if (type === 'message' && stringValue(payload, 'role') === 'developer') {
    const text = textFromContent(payload.content)
    addContext(context, contextKeys, {
      kind: 'developer_context',
      label: 'Developer context message',
      source: 'response_item.message[developer]',
      content: contentExcerpt(
        text,
        options.contentMode === 'all',
        options,
        'Developer context requires --content all.',
      ),
    })
    return
  }

  if (type === 'function_call') {
    timeline.push({
      timestamp,
      kind: 'tool_call',
      toolName: stringValue(payload, 'name'),
      toolCallId: stringValue(payload, 'call_id'),
      content: contentExcerpt(
        codexToolInput(payload.arguments),
        options.contentMode === 'tools' || options.contentMode === 'all',
        options,
        'Tool arguments require --content tools or --content all.',
      ),
      details: { argumentKeys: jsonObjectKeys(payload.arguments) },
    })
    return
  }

  if (type === 'function_call_output') {
    const output = typeof payload.output === 'string' ? payload.output : undefined
    timeline.push({
      timestamp,
      kind: 'tool_result',
      toolCallId: stringValue(payload, 'call_id'),
      content: contentExcerpt(
        output,
        options.contentMode === 'tools' || options.contentMode === 'all',
        options,
        'Tool output requires --content tools or --content all.',
      ),
      details: codexToolOutputDetails(output),
    })
    return
  }

  if (type === 'web_search_call') {
    const action = objectValue(payload, 'action')
    timeline.push({
      timestamp,
      kind: 'tool_call',
      toolName: 'web_search',
      toolCallId: stringValue(payload, 'call_id'),
      content: contentExcerpt(
        action,
        options.contentMode === 'tools' || options.contentMode === 'all',
        options,
        'Web search details require --content tools or --content all.',
      ),
      details: { status: stringValue(payload, 'status'), actionType: stringValue(action, 'type') },
    })
    return
  }

  if (type === 'reasoning') {
    timeline.push({
      timestamp,
      kind: 'reasoning',
      content: contentExcerpt(
        textFromContent(payload.summary),
        options.contentMode === 'all',
        options,
        'Reasoning summaries require --content all.',
      ),
      details: {
        encryptedContentPresent: typeof payload.encrypted_content === 'string' && payload.encrypted_content.length > 0,
      },
    })
  }
}

function codexUsage(value: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!value) return undefined
  const inputTokens = numberValue(value, 'input_tokens') ?? 0
  const outputTokens = numberValue(value, 'output_tokens') ?? 0
  return {
    inputTokens,
    cachedInputTokens: numberValue(value, 'cached_input_tokens') ?? 0,
    cacheCreationInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: numberValue(value, 'reasoning_output_tokens') ?? 0,
    totalTokens: numberValue(value, 'total_tokens') ?? inputTokens + outputTokens,
    totalTokenSemantics: TOKEN_SEMANTICS,
  }
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const entry = item as Record<string, unknown>
    const text = entry.text ?? entry.input_text ?? entry.output_text
    return typeof text === 'string' ? [text] : []
  })
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function addContext(context: ChatContextEntry[], keys: Set<string>, entry: ChatContextEntry): void {
  if (!entry.content && !entry.details) return
  const key = `${entry.kind}|${entry.content?.originalChars ?? 0}|${entry.content?.text ?? ''}`
  if (keys.has(key)) return
  keys.add(key)
  context.push(entry)
}

function jsonObjectKeys(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : []
  } catch {
    return []
  }
}

function codexToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value
    const input = parsed as Record<string, unknown>
    const command = input.cmd ?? input.command
    return typeof command === 'string' ? command : parsed
  } catch {
    return value
  }
}

function codexToolOutputDetails(output: string | undefined): Record<string, unknown> {
  if (!output) return {}
  const exitCode = output.match(/Process exited with code (-?\d+)/)?.[1]
  const originalTokenCount = output.match(/Original token count: (\d+)/)?.[1]
  const chunkId = output.match(/Chunk ID: ([^\s]+)/)?.[1]
  return {
    exitCode: exitCode === undefined ? undefined : Number(exitCode),
    originalTokenCount: originalTokenCount === undefined ? undefined : Number(originalTokenCount),
    chunkId,
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function homeRelative(value: string | undefined): string | undefined {
  return value ? toHomeRelative(value) : undefined
}
