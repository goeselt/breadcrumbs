import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mainChatIdentity } from '../chat-identity.js'
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
import {
  addTokenUsage,
  durationBetween,
  emptyTokenUsage,
  reportTotals,
  sortChats,
  type ChatMetadata,
  type ChatMetadataReport,
  type TokenUsage,
  type ToolUsage,
} from '../chat-metadata.js'
import { toHomeRelative } from '../path.js'
import { addModelUsage, sortedModels, uniqueStrings } from './shared.js'
import { COPILOT_TOKEN_SEMANTICS } from './copilot.js'

export const COPILOT_TRACE_SOURCE_FORMAT = 'copilot-agent-traces-sqlite'
export const COPILOT_TRACE_PARSER_VERSION = 3

interface TraceSpan {
  span_id: string
  trace_id: string
  parent_span_id: string | null
  name: string
  start_time_ms: number
  end_time_ms: number
  status_code: number
  status_message: string | null
  operation_name: string | null
  provider_name: string | null
  agent_name: string | null
  conversation_id: string | null
  request_model: string | null
  response_model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  reasoning_tokens: number | null
  tool_name: string | null
  tool_call_id: string | null
  tool_type: string | null
  chat_session_id: string | null
  turn_index: number | null
  ttft_ms: number | null
}

interface SpanAttribute {
  span_id: string
  key: string
  value: string | null
}

interface SpanEvent {
  id: number
  span_id: string
  name: string
  timestamp_ms: number
  attributes: string | null
}

export function copilotTraceDatabaseCandidates(home = homedir()): string[] {
  return [
    path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    path.join(
      home,
      '.vscode-server-insiders',
      'data',
      'User',
      'globalStorage',
      'github.copilot-chat',
      'agent-traces.db',
    ),
    path.join(home, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
  ]
}

export function copilotDebugLogRootCandidates(home = homedir()): string[] {
  return [
    path.join(home, '.vscode-server', 'data', 'User', 'workspaceStorage'),
    path.join(home, '.vscode-server-insiders', 'data', 'User', 'workspaceStorage'),
    path.join(home, '.config', 'Code', 'User', 'workspaceStorage'),
    path.join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
  ]
}

export async function findCopilotTraceDatabase(): Promise<string | undefined> {
  for (const candidate of copilotTraceDatabaseCandidates()) {
    if (await isFile(candidate)) return candidate
  }
  return undefined
}

export async function readCopilotTraceMetadata(databaseFile: string): Promise<ChatMetadataReport> {
  const database = openTraceDatabase(databaseFile)
  try {
    const roots = database
      .prepare(
        `
      SELECT * FROM spans
      WHERE operation_name = 'invoke_agent'
        AND chat_session_id IS NOT NULL
        AND (agent_name = 'GitHub Copilot Chat' OR name = 'invoke_agent GitHub Copilot Chat')
      ORDER BY start_time_ms
    `,
      )
      .all() as unknown as TraceSpan[]
    const sessionIds = uniqueStrings(roots.map((root) => root.chat_session_id ?? undefined))
    const chats = sortChats(
      sessionIds
        .map((sessionId) => summarizeTraceSession(database, databaseFile, sessionId))
        .filter((chat) => chat.requests > 0),
    )
    const stats = await stat(databaseFile)
    const spanCount = numberColumn(database, 'SELECT COUNT(*) AS value FROM spans')

    return {
      schemaVersion: 2,
      reportType: 'chat-metadata-list',
      provider: 'copilot',
      generatedAt: new Date().toISOString(),
      source: {
        path: toHomeRelative(databaseFile),
        exists: true,
        filesRead: 1,
        recordsRead: spanCount,
        invalidRecords: 0,
        note: `SQLite trace database (${stats.size} bytes).`,
      },
      privacy: {
        contentReadDuringParsing: true,
        contentEmitted: false,
        note: 'The metadata adapter reads allowlisted span columns and emits no captured conversation content.',
      },
      index: {
        storagePath: toHomeRelative(databaseFile),
        files: [
          {
            sourceId: mainChatIdentity('copilot', 'trace-database', databaseFile).sourceId,
            sourcePath: toHomeRelative(databaseFile),
            mode: 'rebuild',
            appendedRecords: spanCount,
            parserVersion: COPILOT_TRACE_PARSER_VERSION,
            sourceFormat: COPILOT_TRACE_SOURCE_FORMAT,
            diagnostics: {
              recordsRead: spanCount,
              recordsUsed: chats.reduce((sum, chat) => sum + chat.requests + (chat.tools?.calls ?? 0), 0),
              recordsIgnored: 0,
              invalidJsonLines: 0,
              unsupportedRecords: 0,
              partialLinePending: false,
              warnings: [],
              confidence: 'high',
            },
          },
        ],
      },
      totals: reportTotals(chats, COPILOT_TOKEN_SEMANTICS),
      chats,
    }
  } finally {
    database.close()
  }
}

export async function readCopilotTraceDetail(
  metadata: ChatMetadata,
  inputOptions: ChatDetailOptions = {},
): Promise<ChatDetailReport> {
  const options = resolveChatDetailOptions(inputOptions)
  const databaseFile = path.resolve(metadata.sourcePath.replace(/^~(?=$|[/\\])/, homedir()))
  if (!(await isFile(databaseFile))) {
    return emptyChatDetailReport('copilot', metadata.chatKey, options, 'Copilot trace database not found.')
  }

  const database = openTraceDatabase(databaseFile)
  try {
    const spans = database
      .prepare(
        `
      SELECT * FROM spans
      WHERE chat_session_id = ?
      ORDER BY start_time_ms, end_time_ms
    `,
      )
      .all(metadata.providerChatId) as unknown as TraceSpan[]
    if (spans.length === 0) {
      return emptyChatDetailReport('copilot', metadata.chatKey, options, 'Copilot trace session not found.')
    }
    const attributes = loadSessionAttributes(database, metadata.providerChatId)
    const events = database
      .prepare(
        `
      SELECT e.* FROM span_events e
      JOIN spans s ON s.span_id = e.span_id
      WHERE s.chat_session_id = ?
      ORDER BY e.timestamp_ms, e.id
    `,
      )
      .all(metadata.providerChatId) as unknown as SpanEvent[]
    const eventsBySpan = groupEvents(events)
    const timeline: ChatDetailEvent[] = []
    const context: ChatContextEntry[] = []
    const latestModelSpanByRoot = new Map<string, string>()
    let sessionEventEmitted = false

    for (const span of spans) {
      const spanAttributes = attributes.get(span.span_id) ?? new Map()
      if (span.operation_name === 'invoke_agent') {
        if (!sessionEventEmitted) {
          timeline.push({
            timestamp: isoTime(span.start_time_ms),
            kind: 'session',
            id: span.span_id,
            model: span.response_model ?? span.request_model ?? undefined,
            details: {
              state: 'started',
              agentName: span.agent_name ?? undefined,
            },
          })
          sessionEventEmitted = true
        }
        for (const event of eventsBySpan.get(span.span_id) ?? []) {
          if (event.name !== 'user_message') continue
          const eventAttributes = parseObject(event.attributes)
          timeline.push({
            timestamp: isoTime(event.timestamp_ms),
            kind: 'user_message',
            id: `event:${event.id}`,
            parentId: span.span_id,
            role: 'user',
            content: contentExcerpt(
              eventAttributes.content,
              options.contentMode === 'messages' || options.contentMode === 'all',
              options,
              'Captured Copilot user input is hidden by the selected content mode.',
            ),
            details: {
              agentRequestId: span.span_id,
              traceId: span.trace_id,
              requestDurationMs: durationMs(span),
              requestTurnCount: attributeNumber(spanAttributes, 'copilot_chat.turn_count'),
            },
          })
        }
        continue
      }

      if (span.operation_name === 'chat') {
        const usage = spanUsage(span)
        timeline.push({
          timestamp: isoTime(span.start_time_ms),
          kind: 'model_request',
          id: span.span_id,
          parentId: span.parent_span_id ?? undefined,
          requestId: attributeString(spanAttributes, 'gen_ai.response.id') ?? span.span_id,
          model: span.response_model ?? span.request_model ?? undefined,
          usage,
          durationMs: durationMs(span),
          timeToFirstTokenMs: span.ttft_ms ?? undefined,
          success: span.status_code !== 2,
          details: {
            operation: span.operation_name,
            finishReasons: parsedAttribute(spanAttributes, 'gen_ai.response.finish_reasons'),
            maxTokens: attributeNumber(spanAttributes, 'gen_ai.request.max_tokens'),
          },
        })
        if (span.parent_span_id) latestModelSpanByRoot.set(span.parent_span_id, span.span_id)

        const reasoning = spanAttributes.get('copilot_chat.reasoning_content')
        if (reasoning !== undefined) {
          timeline.push({
            timestamp: isoTime(span.end_time_ms),
            kind: 'reasoning',
            id: `${span.span_id}:reasoning`,
            parentId: span.span_id,
            content: contentExcerpt(
              reasoning,
              options.contentMode === 'messages' || options.contentMode === 'all',
              options,
              'Captured Copilot reasoning is hidden by the selected content mode.',
            ),
          })
        }
        const output = spanAttributes.get('gen_ai.output.messages')
        const outputText = messageText(output)
        if (outputText) {
          timeline.push({
            timestamp: isoTime(span.end_time_ms),
            kind: 'assistant_message',
            id: `${span.span_id}:output`,
            parentId: span.span_id,
            role: 'assistant',
            content: contentExcerpt(
              outputText,
              options.contentMode === 'messages' || options.contentMode === 'all',
              options,
              'Captured Copilot output is hidden by the selected content mode.',
            ),
          })
        }
        continue
      }

      if (span.operation_name === 'execute_tool') {
        const inferredParent = span.parent_span_id
          ? (latestModelSpanByRoot.get(span.parent_span_id) ?? span.parent_span_id)
          : undefined
        const toolCallId = span.tool_call_id || attributeString(spanAttributes, 'gen_ai.tool.call.id')
        timeline.push({
          timestamp: isoTime(span.start_time_ms),
          kind: 'tool_call',
          id: span.span_id,
          parentId: inferredParent,
          toolName: span.tool_name ?? span.name.replace(/^execute_tool\s+/, ''),
          toolCallId: toolCallId || undefined,
          durationMs: durationMs(span),
          success: span.status_code !== 2,
          content: contentExcerpt(
            spanAttributes.get('gen_ai.tool.call.arguments'),
            options.contentMode === 'tools' || options.contentMode === 'all',
            options,
            'Captured Copilot tool arguments are hidden by the selected content mode.',
          ),
          details: {
            toolType: span.tool_type ?? undefined,
            argumentKeys: objectKeys(spanAttributes.get('gen_ai.tool.call.arguments')),
          },
        })
        const result = spanAttributes.get('gen_ai.tool.call.result')
        if (result !== undefined) {
          timeline.push({
            timestamp: isoTime(span.end_time_ms),
            kind: 'tool_result',
            id: `${span.span_id}:result`,
            parentId: span.span_id,
            toolName: span.tool_name ?? undefined,
            toolCallId: toolCallId || undefined,
            success: span.status_code !== 2,
            content: contentExcerpt(
              result,
              options.contentMode === 'tools' || options.contentMode === 'all',
              options,
              'Captured Copilot tool output is hidden by the selected content mode.',
            ),
          })
        }
      }
    }

    const firstSystemInstructions = [...attributes.values()]
      .map((entry) => entry.get('gen_ai.system_instructions'))
      .find((value) => value !== undefined)
    if (firstSystemInstructions !== undefined) {
      context.push({
        kind: 'system_instructions',
        label: 'Copilot system instructions',
        source: 'agent-traces.db: gen_ai.system_instructions',
        content: contentExcerpt(
          firstSystemInstructions,
          options.contentMode === 'all',
          options,
          'System instructions require the All details content mode.',
        ),
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
        path: toHomeRelative(databaseFile),
        recordsRead: spans.length + events.length,
        invalidRecords: 0,
      },
      metadata,
      context,
      timeline,
      options,
    })
  } finally {
    database.close()
  }
}

function summarizeTraceSession(database: DatabaseSync, databaseFile: string, sessionId: string): ChatMetadata {
  const spans = database
    .prepare(
      `
    SELECT * FROM spans WHERE chat_session_id = ? ORDER BY start_time_ms, end_time_ms
  `,
    )
    .all(sessionId) as unknown as TraceSpan[]
  const roots = spans.filter((span) => span.operation_name === 'invoke_agent')
  const inferenceSpans = spans.filter((span) => span.operation_name === 'chat')
  const toolSpans = spans.filter((span) => span.operation_name === 'execute_tool')
  const tokens = emptyTokenUsage(COPILOT_TOKEN_SEMANTICS)
  const models = new Map<string, ReturnType<typeof sortedModels>[number]>()
  for (const span of inferenceSpans) {
    const usage = spanUsage(span)
    addTokenUsage(tokens, usage)
    addModelUsage(models, span.response_model ?? span.request_model ?? undefined, usage, 1, durationMs(span))
  }
  const firstUserMessage = database
    .prepare(
      `
    SELECT e.attributes FROM span_events e
    JOIN spans s ON s.span_id = e.span_id
    WHERE s.chat_session_id = ? AND e.name = 'user_message'
    ORDER BY e.timestamp_ms LIMIT 1
  `,
    )
    .get(sessionId) as { attributes?: string } | undefined
  const rootAttributes = loadRootAttributes(database, sessionId)
  const startedAt = isoTime(Math.min(...spans.map((span) => span.start_time_ms)))
  const endedAt = isoTime(Math.max(...spans.map((span) => span.end_time_ms)))
  const ttftValues = inferenceSpans.flatMap((span) => (span.ttft_ms === null ? [] : [span.ttft_ms]))
  const title = titleFromUserMessage(firstUserMessage?.attributes)

  return {
    provider: 'copilot',
    ...mainChatIdentity('copilot', sessionId, databaseFile),
    chatId: sessionId,
    sourcePath: toHomeRelative(databaseFile),
    title,
    startedAt,
    endedAt,
    wallClockDurationMs: durationBetween(startedAt, endedAt),
    workspacePaths: [],
    repositoryUrl: firstAttribute(rootAttributes, 'copilot_chat.repo.remote_url'),
    branch:
      firstAttribute(rootAttributes, 'copilot_chat.repo.head_branch_name') ??
      firstAttribute(rootAttributes, 'github.copilot.git.branch'),
    requests: inferenceSpans.length,
    turns: numberColumn(
      database,
      `
      SELECT COUNT(*) AS value FROM span_events e
      JOIN spans s ON s.span_id = e.span_id
      WHERE s.chat_session_id = ? AND e.name = 'turn_start'
    `,
      sessionId,
    ),
    models: sortedModels(models),
    tokens,
    performance: {
      modelDurationMs: inferenceSpans.reduce((sum, span) => sum + durationMs(span), 0),
      averageTimeToFirstTokenMs:
        ttftValues.length > 0 ? ttftValues.reduce((sum, value) => sum + value, 0) / ttftValues.length : undefined,
    },
    tools: summarizeTools(toolSpans),
    billing: {
      status: 'unavailable',
      note: 'Copilot traces expose token usage and sometimes nano-AIU attributes, but no stable per-chat credit total.',
    },
    providerMetadata: {
      sourceFormat: COPILOT_TRACE_SOURCE_FORMAT,
      agentNames: uniqueStrings(roots.map((root) => root.agent_name ?? undefined)),
      agentTypes: uniqueStrings(rootAttributes.map((attributes) => attributes.get('github.copilot.agent.type'))),
      traceIds: uniqueStrings(roots.map((root) => root.trace_id)),
      agentRequests: roots.length,
    },
    dataQuality: {
      confidence: 'high',
      deduplication:
        'Only child chat spans count as model requests and token usage; aggregate invoke_agent span totals are excluded.',
      caveats: [
        'The trace database is an internal Copilot data source and its schema may change between VS Code releases.',
        'Chat titles are derived from the first captured user message when no separate title source is available.',
      ],
    },
  }
}

function openTraceDatabase(databaseFile: string): DatabaseSync {
  const database = new DatabaseSync(databaseFile, { readOnly: true })
  const missing = missingTraceSchemaParts(database)
  if (missing.length > 0) {
    database.close()
    throw new Error(`Unsupported Copilot agent trace database schema. Missing: ${missing.join(', ')}.`)
  }
  return database
}

const REQUIRED_TRACE_SCHEMA = {
  spans: [
    'span_id',
    'trace_id',
    'parent_span_id',
    'name',
    'start_time_ms',
    'end_time_ms',
    'status_code',
    'status_message',
    'operation_name',
    'provider_name',
    'agent_name',
    'conversation_id',
    'request_model',
    'response_model',
    'input_tokens',
    'output_tokens',
    'cached_tokens',
    'reasoning_tokens',
    'tool_name',
    'tool_call_id',
    'tool_type',
    'chat_session_id',
    'turn_index',
    'ttft_ms',
  ],
  span_attributes: ['span_id', 'key', 'value'],
  span_events: ['id', 'span_id', 'name', 'timestamp_ms', 'attributes'],
} as const

function missingTraceSchemaParts(database: DatabaseSync): string[] {
  const tableNames = new Set(
    (
      database
        .prepare(
          `
    SELECT name FROM sqlite_master WHERE type = 'table'
  `,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  )
  const missing: string[] = []

  for (const [table, requiredColumns] of Object.entries(REQUIRED_TRACE_SCHEMA)) {
    if (!tableNames.has(table)) {
      missing.push(`table ${table}`)
      continue
    }
    const columns = new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
    )
    for (const column of requiredColumns) {
      if (!columns.has(column)) missing.push(`${table}.${column}`)
    }
  }

  return missing
}

function loadSessionAttributes(database: DatabaseSync, sessionId: string): Map<string, Map<string, string>> {
  const rows = database
    .prepare(
      `
    SELECT a.* FROM span_attributes a
    JOIN spans s ON s.span_id = a.span_id
    WHERE s.chat_session_id = ?
  `,
    )
    .all(sessionId) as unknown as SpanAttribute[]
  const result = new Map<string, Map<string, string>>()
  for (const row of rows) {
    if (row.value === null) continue
    const attributes = result.get(row.span_id) ?? new Map<string, string>()
    attributes.set(row.key, row.value)
    result.set(row.span_id, attributes)
  }
  return result
}

function loadRootAttributes(database: DatabaseSync, sessionId: string): Map<string, string>[] {
  const attributes = loadSessionAttributes(database, sessionId)
  const rootIds = database
    .prepare(
      `
    SELECT span_id FROM spans WHERE chat_session_id = ? AND operation_name = 'invoke_agent'
  `,
    )
    .all(sessionId) as Array<{ span_id: string }>
  return rootIds.map((row) => attributes.get(row.span_id) ?? new Map())
}

function groupEvents(events: SpanEvent[]): Map<string, SpanEvent[]> {
  const grouped = new Map<string, SpanEvent[]>()
  for (const event of events) {
    const entries = grouped.get(event.span_id) ?? []
    entries.push(event)
    grouped.set(event.span_id, entries)
  }
  return grouped
}

function spanUsage(span: TraceSpan): TokenUsage {
  const inputTokens = span.input_tokens ?? 0
  const outputTokens = span.output_tokens ?? 0
  return {
    inputTokens,
    cachedInputTokens: span.cached_tokens ?? 0,
    cacheCreationInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: span.reasoning_tokens ?? 0,
    totalTokens: inputTokens + outputTokens,
    totalTokenSemantics: COPILOT_TOKEN_SEMANTICS,
  }
}

function summarizeTools(spans: TraceSpan[]): ToolUsage {
  const byTool = new Map<string, { tool: string; calls: number; durationMs: number }>()
  for (const span of spans) {
    const tool = (span.tool_name ?? span.name.replace(/^execute_tool\s+/, '')) || '(unknown)'
    const current = byTool.get(tool) ?? { tool, calls: 0, durationMs: 0 }
    current.calls += 1
    current.durationMs += durationMs(span)
    byTool.set(tool, current)
  }
  return {
    calls: spans.length,
    durationMs: spans.reduce((sum, span) => sum + durationMs(span), 0),
    byTool: [...byTool.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
  }
}

function durationMs(span: TraceSpan): number {
  return Math.max(0, span.end_time_ms - span.start_time_ms)
}

function isoTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString()
}

function titleFromUserMessage(attributes: string | undefined): string | undefined {
  const { content } = parseObject(attributes)
  if (typeof content !== 'string') return undefined
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized || undefined
}

function messageText(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const messages = JSON.parse(value)
    if (!Array.isArray(messages)) return value
    const text = messages
      .flatMap((message) => {
        if (!message || typeof message !== 'object') return []
        const { parts } = message as { parts?: unknown }
        if (!Array.isArray(parts)) return []
        return parts.flatMap((part) =>
          part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { content?: unknown }).content === 'string'
            ? [(part as { content: string }).content]
            : [],
        )
      })
      .join('\n')
    return text || undefined
  } catch {
    return value
  }
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parsedAttribute(attributes: Map<string, string>, key: string): unknown {
  const value = attributes.get(key)
  if (value === undefined) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function attributeString(attributes: Map<string, string>, key: string): string | undefined {
  const value = attributes.get(key)
  return value || undefined
}

function attributeNumber(attributes: Map<string, string>, key: string): number | undefined {
  const value = Number(attributes.get(key))
  return Number.isFinite(value) ? value : undefined
}

function firstAttribute(attributes: Map<string, string>[], key: string): string | undefined {
  return attributes.map((entry) => entry.get(key)).find((value) => Boolean(value))
}

function objectKeys(value: string | undefined): string[] | undefined {
  const object = parseObject(value)
  const keys = Object.keys(object)
  return keys.length > 0 ? keys : undefined
}

function numberColumn(database: DatabaseSync, sql: string, ...params: string[]): number {
  const row = database.prepare(sql).get(...params) as { value?: number } | undefined
  return row?.value ?? 0
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
