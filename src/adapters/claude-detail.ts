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
import { readClaudeChatMetadata } from './claude.js'

const TOKEN_SEMANTICS = 'input_plus_cache_creation_plus_cache_read_plus_output' as const

interface ClaudeRequest {
  timestamp?: string
  requestId?: string
  model?: string
  usage: TokenUsage
}

export async function readClaudeChatDetail(
  chatReference: string,
  inputOptions: ChatDetailOptions = {},
  rootInput = '~/.claude/projects',
  metadataInput?: ChatMetadata,
): Promise<ChatDetailReport> {
  const options = resolveChatDetailOptions(inputOptions)
  const resolution = metadataInput
    ? { chat: metadataInput }
    : resolveChatReference((await readClaudeChatMetadata(rootInput)).chats, chatReference)
  const metadata = resolution.chat
  if (!metadata) {
    return emptyChatDetailReport('claude', chatReference, options, resolution.note ?? 'Claude chat not found.')
  }

  const file = expandHome(metadata.sourcePath, homedir())
  const timeline: ChatDetailEvent[] = []
  const context: ChatContextEntry[] = []
  const contextKeys = new Set<string>()
  const requests = new Map<string, ClaudeRequest>()
  const stats = await readJsonl(file, (record) => {
    const timestamp = stringValue(record, 'timestamp')
    const type = stringValue(record, 'type')

    if (type === 'assistant' || type === 'user') {
      readMessage(record, timestamp, options, timeline, context, contextKeys, requests)
      return
    }

    if (type === 'attachment') {
      const attachment = objectValue(record, 'attachment')
      addContext(context, contextKeys, {
        kind: 'attachment',
        label: stringValue(attachment, 'type') ?? 'Claude attachment',
        source: 'attachment',
        content: contentExcerpt(
          attachment?.content,
          options.contentMode === 'all',
          options,
          'Attachment content requires --content all.',
        ),
        details: {
          keys: attachment ? Object.keys(attachment).filter((key) => key !== 'content') : [],
          itemCount: numberValue(attachment, 'itemCount'),
          skillCount: numberValue(attachment, 'skillCount'),
          names: stringArray(attachment?.names),
        },
      })
      return
    }

    if (type === 'ai-title') {
      addContext(context, contextKeys, {
        kind: 'title',
        label: 'Claude-generated chat title',
        source: 'ai-title',
        content: contentExcerpt(
          record.aiTitle,
          options.contentMode === 'messages' || options.contentMode === 'all',
          options,
          'Chat title requires --content messages or --content all.',
        ),
      })
      return
    }

    if (type === 'mode') {
      addContext(context, contextKeys, {
        kind: 'mode',
        label: 'Claude session mode',
        source: 'mode',
        details: { mode: stringValue(record, 'mode') },
      })
    }
  })

  for (const [messageId, request] of requests) {
    timeline.push({
      timestamp: request.timestamp,
      kind: 'model_request',
      id: messageId,
      requestId: request.requestId,
      model: request.model,
      usage: request.usage,
    })
  }

  return finalizeChatDetailReport({
    schemaVersion: 2,
    reportType: 'chat-detail',
    provider: 'claude',
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

function readMessage(
  record: Record<string, unknown>,
  timestamp: string | undefined,
  options: ReturnType<typeof resolveChatDetailOptions>,
  timeline: ChatDetailEvent[],
  context: ChatContextEntry[],
  contextKeys: Set<string>,
  requests: Map<string, ClaudeRequest>,
): void {
  const message = objectValue(record, 'message')
  if (!message) return
  const role = stringValue(message, 'role') ?? stringValue(record, 'type')
  const recordId = stringValue(record, 'uuid')
  const parentId = stringValue(record, 'parentUuid')
  const messageId = stringValue(message, 'id')
  const requestId = stringValue(record, 'requestId')
  const model = stringValue(message, 'model')
  const usageValue = objectValue(message, 'usage')
  if (messageId && usageValue) {
    requests.set(messageId, {
      timestamp,
      requestId,
      model,
      usage: claudeUsage(usageValue),
    })
  }

  const blocks = contentBlocks(message.content)
  for (const [blockIndex, block] of blocks.entries()) {
    const blockType = stringValue(block, 'type') ?? 'text'
    if (blockType === 'tool_use') {
      const { input } = block
      const inputObject =
        input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
      timeline.push({
        timestamp,
        kind: 'tool_call',
        id: recordId ? `${recordId}:${blockIndex}` : undefined,
        parentId,
        requestId,
        model,
        toolName: stringValue(block, 'name'),
        toolCallId: stringValue(block, 'id'),
        content: contentExcerpt(
          toolInputContent(input, inputObject),
          options.contentMode === 'tools' || options.contentMode === 'all',
          options,
          'Tool input requires --content tools or --content all.',
        ),
        details: {
          inputKeys: inputObject ? Object.keys(inputObject) : [],
          subagentType: stringValue(inputObject, 'subagent_type'),
          subagentModel: stringValue(inputObject, 'model'),
        },
      })
      continue
    }

    if (blockType === 'tool_result') {
      const toolResult = objectValue(record, 'toolUseResult')
      timeline.push({
        timestamp,
        kind: 'tool_result',
        id: recordId ? `${recordId}:${blockIndex}` : undefined,
        parentId,
        toolCallId: stringValue(block, 'tool_use_id'),
        content: contentExcerpt(
          block.content ?? record.toolUseResult,
          options.contentMode === 'tools' || options.contentMode === 'all',
          options,
          'Tool result requires --content tools or --content all.',
        ),
        success: typeof block.is_error === 'boolean' ? !block.is_error : undefined,
        details: {
          resultKeys: toolResult ? Object.keys(toolResult) : [],
          agentId: stringValue(toolResult, 'agentId'),
          agentType: stringValue(toolResult, 'agentType'),
          status: stringValue(toolResult, 'status'),
          totalDurationMs: numberValue(toolResult, 'totalDurationMs'),
          totalTokens: numberValue(toolResult, 'totalTokens'),
          totalToolUseCount: numberValue(toolResult, 'totalToolUseCount'),
        },
      })
      continue
    }

    if (blockType === 'thinking') {
      timeline.push({
        timestamp,
        kind: 'reasoning',
        id: recordId ? `${recordId}:${blockIndex}` : undefined,
        parentId,
        requestId,
        model,
        content: contentExcerpt(
          block.thinking,
          options.contentMode === 'all',
          options,
          'Thinking content requires --content all.',
        ),
        details: {
          signaturePresent: typeof block.signature === 'string' && block.signature.length > 0,
        },
      })
      continue
    }

    const isMeta = record.isMeta === true
    const text = block.text ?? block.content
    const excerpt = contentExcerpt(
      text,
      options.contentMode === 'messages' || options.contentMode === 'all',
      options,
      'Message content requires --content messages or --content all.',
    )
    if (isMeta) {
      addContext(context, contextKeys, {
        kind: 'meta_message',
        label: 'Claude meta/context message',
        source: recordId,
        content: excerpt,
      })
    } else {
      timeline.push({
        timestamp,
        kind: role === 'assistant' ? 'assistant_message' : 'user_message',
        id: recordId ? `${recordId}:${blockIndex}` : undefined,
        parentId,
        requestId,
        role,
        model: role === 'assistant' ? model : undefined,
        content: excerpt,
      })
    }
  }
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  )
}

function toolInputContent(input: unknown, inputObject: Record<string, unknown> | undefined): unknown {
  const command = inputObject?.cmd ?? inputObject?.command
  return typeof command === 'string' ? command : input
}

function claudeUsage(value: Record<string, unknown>): TokenUsage {
  const inputTokens = numberValue(value, 'input_tokens') ?? 0
  const cachedInputTokens = numberValue(value, 'cache_read_input_tokens') ?? 0
  const cacheCreationInputTokens = numberValue(value, 'cache_creation_input_tokens') ?? 0
  const outputTokens = numberValue(value, 'output_tokens') ?? 0
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens,
    totalTokenSemantics: TOKEN_SEMANTICS,
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function addContext(context: ChatContextEntry[], keys: Set<string>, entry: ChatContextEntry): void {
  const key = `${entry.kind}|${entry.label}|${entry.content?.originalChars ?? 0}|${entry.content?.text ?? ''}|${JSON.stringify(entry.details)}`
  if (keys.has(key)) return
  keys.add(key)
  context.push(entry)
}
