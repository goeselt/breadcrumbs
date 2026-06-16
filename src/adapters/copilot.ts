import { stat } from 'node:fs/promises'
import { mainChatIdentity } from '../chat-identity.js'
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
import { numberValue, objectValue, readJsonl, stringValue } from '../jsonl.js'
import { expandHome, toHomeRelative } from '../path.js'
import { addModelUsage, sortedModels } from './shared.js'

export const COPILOT_TOKEN_SEMANTICS = 'input_plus_output; cache_fields_are_reported_separately' as const

export interface CopilotMetadataRecord {
  timestamp: string
  timestampMs: number
  traceId?: string
  attributes: Record<string, unknown>
}

interface CopilotSession {
  id: string
  traceId?: string
  startedAt: string
  endedAt: string
  records: CopilotMetadataRecord[]
}

export async function readCopilotChatMetadata(
  fileInput = '~/.cache/vscode-chat-token-usage/copilot-otel.jsonl',
): Promise<ChatMetadataReport> {
  const file = expandHome(fileInput)
  const records: CopilotMetadataRecord[] = []
  const fileExists = await pathExists(file)
  let recordsRead = 0
  let invalidRecords = 0

  if (fileExists) {
    const stats = await readJsonl(file, (record) => {
      const normalized = projectCopilotMetadataRecord(record)
      if (normalized) records.push(normalized)
    })
    ;({ recordsRead, invalidRecords } = stats)
  }

  records.sort((a, b) => a.timestampMs - b.timestampMs)
  const chats = summarizeCopilotMetadataRecords(records, file).filter((chat) => chat.requests > 0)

  return {
    schemaVersion: 2,
    reportType: 'chat-metadata-list',
    provider: 'copilot',
    generatedAt: new Date().toISOString(),
    source: {
      path: toHomeRelative(file),
      exists: fileExists,
      filesRead: fileExists ? 1 : 0,
      recordsRead,
      invalidRecords,
      note: fileExists
        ? chats.length === 0
          ? 'The file contains no copilot_chat.session.start records.'
          : undefined
        : 'Copilot OTel JSONL file not found.',
    },
    privacy: {
      contentReadDuringParsing: true,
      contentEmitted: false,
      note: 'The OTel exporter may contain content when captureContent is enabled. The adapter emits only allowlisted metadata.',
    },
    totals: reportTotals(chats, COPILOT_TOKEN_SEMANTICS),
    chats,
  }
}

export function projectCopilotMetadataRecord(record: Record<string, unknown>): CopilotMetadataRecord | undefined {
  const { hrTime } = record
  const attributes = objectValue(record, 'attributes')
  if (!Array.isArray(hrTime) || hrTime.length < 2 || !attributes) return undefined
  const seconds = typeof hrTime[0] === 'number' ? hrTime[0] : Number(hrTime[0])
  const nanoseconds = typeof hrTime[1] === 'number' ? hrTime[1] : Number(hrTime[1])
  if (!Number.isFinite(seconds) || !Number.isFinite(nanoseconds)) return undefined
  const timestampMs = seconds * 1000 + nanoseconds / 1_000_000
  const spanContext = objectValue(record, 'spanContext')
  const projectedAttributes = Object.fromEntries(
    COPILOT_METADATA_ATTRIBUTES.flatMap((key) => (attributes[key] === undefined ? [] : [[key, attributes[key]]])),
  )
  return {
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    traceId: stringValue(spanContext, 'traceId'),
    attributes: projectedAttributes,
  }
}

export function summarizeCopilotMetadataRecords(records: CopilotMetadataRecord[], sourceFile: string): ChatMetadata[] {
  const sessions = assignSessions(records.slice().sort((a, b) => a.timestampMs - b.timestampMs))
  return sortChats(sessions.map((session) => summarizeSession(session, sourceFile)))
}

function assignSessions(records: CopilotMetadataRecord[]): CopilotSession[] {
  const sessions = records
    .filter((record) => stringValue(record.attributes, 'event.name') === 'copilot_chat.session.start')
    .map((record, index) => ({
      id: stringValue(record.attributes, 'session.id') ?? `copilot-session-${index + 1}`,
      traceId: record.traceId,
      startedAt: record.timestamp,
      endedAt: record.timestamp,
      records: [] as CopilotMetadataRecord[],
    }))

  const byTrace = new Map(sessions.filter((session) => session.traceId).map((session) => [session.traceId!, session]))

  // Establish the observed traced lifetime first. Trace-less helper calls are only safe to attach inside it.
  for (const record of records) {
    const session = record.traceId ? byTrace.get(record.traceId) : undefined
    if (!session) continue
    session.records.push(record)
    if (record.timestampMs > Date.parse(session.endedAt)) session.endedAt = record.timestamp
  }

  for (const record of records) {
    if (record.traceId) continue
    for (const session of sessions) {
      if (record.timestampMs < Date.parse(session.startedAt) || record.timestampMs > Date.parse(session.endedAt))
        continue
      session.records.push(record)
      break
    }
  }

  return sessions
}

function summarizeSession(session: CopilotSession, sourceFile: string): ChatMetadata {
  const tokens = emptyTokenUsage(COPILOT_TOKEN_SEMANTICS)
  const models = new Map<string, ReturnType<typeof sortedModels>[number]>()
  const turns = new Set<number>()
  const agentNames = new Set<string>()
  const agentTypes = new Set<string>()
  const inferenceEvents = new Set<string>()
  const toolEvents = new Map<string, { tool: string; durationMs?: number }>()

  for (const record of session.records) {
    const eventName = stringValue(record.attributes, 'event.name')
    const agentName = stringValue(record.attributes, 'gen_ai.agent.name')
    const agentType = stringValue(record.attributes, 'github.copilot.agent.type')
    if (agentName) agentNames.add(agentName)
    if (agentType) agentTypes.add(agentType)

    if (eventName === 'copilot_chat.agent.turn') {
      const turn = numberValue(record.attributes, 'turn.index')
      if (turn !== undefined) turns.add(turn)
    }

    if (eventName === 'gen_ai.client.inference.operation.details') {
      const usage = copilotUsage(record.attributes)
      const model =
        stringValue(record.attributes, 'gen_ai.response.model') ??
        stringValue(record.attributes, 'gen_ai.request.model')
      const identity = [
        record.timestamp,
        stringValue(record.attributes, 'gen_ai.response.id'),
        model,
        usage.inputTokens,
        usage.outputTokens,
      ].join('|')
      if (!inferenceEvents.has(identity)) {
        inferenceEvents.add(identity)
        addTokenUsage(tokens, usage)
        addModelUsage(models, model, usage)
      }
    }

    if (eventName === 'copilot_chat.tool.call') {
      const tool = stringValue(record.attributes, 'gen_ai.tool.name') ?? '(unknown)'
      const identity = `${record.timestamp}|${tool}`
      const durationMs = numberValue(record.attributes, 'duration_ms')
      const previous = toolEvents.get(identity)
      if (!previous || (durationMs ?? 0) > (previous.durationMs ?? 0)) toolEvents.set(identity, { tool, durationMs })
    }
  }

  return {
    provider: 'copilot',
    ...mainChatIdentity('copilot', session.id, sourceFile),
    chatId: session.id,
    sourcePath: toHomeRelative(sourceFile),
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    wallClockDurationMs: durationBetween(session.startedAt, session.endedAt),
    workspacePaths: [],
    requests: inferenceEvents.size,
    turns: turns.size,
    models: sortedModels(models),
    tokens,
    tools: summarizeTools(toolEvents.values()),
    billing: {
      status: 'unavailable',
      note: 'Copilot OTel reports token usage but not premium-request credits or per-chat cost.',
    },
    providerMetadata: {
      agentNames: [...agentNames].sort(),
      agentTypes: [...agentTypes].sort(),
      traceId: session.traceId,
    },
    dataQuality: {
      confidence: 'medium',
      deduplication:
        'Only inference detail events count as requests; duplicate agent.turn token totals are ignored. Tool duplicates use timestamp and tool name.',
      caveats: [
        'Trace-less auxiliary model calls are assigned within the observed traced session lifetime.',
        'No session-end event was observed, so the final assigned event defines the end time.',
        'The exporter may flush buffered records only when the extension host shuts down.',
      ],
    },
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
    totalTokenSemantics: COPILOT_TOKEN_SEMANTICS,
  }
}

const COPILOT_METADATA_ATTRIBUTES = [
  'event.name',
  'session.id',
  'gen_ai.agent.name',
  'github.copilot.agent.type',
  'turn.index',
  'gen_ai.response.model',
  'gen_ai.request.model',
  'gen_ai.response.id',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
  'gen_ai.usage.reasoning.output_tokens',
  'gen_ai.tool.name',
  'duration_ms',
] as const

function summarizeTools(events: Iterable<{ tool: string; durationMs?: number }>): ToolUsage | undefined {
  const byTool = new Map<string, { tool: string; calls: number; durationMs?: number }>()
  let calls = 0
  let durationMs = 0
  let hasDuration = false

  for (const event of events) {
    calls += 1
    const aggregate = byTool.get(event.tool) ?? { tool: event.tool, calls: 0 }
    aggregate.calls += 1
    if (event.durationMs !== undefined) {
      durationMs += event.durationMs
      hasDuration = true
      aggregate.durationMs = (aggregate.durationMs ?? 0) + event.durationMs
    }
    byTool.set(event.tool, aggregate)
  }

  if (calls === 0) return undefined
  return {
    calls,
    durationMs: hasDuration ? durationMs : undefined,
    byTool: [...byTool.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
  }
}

async function pathExists(input: string): Promise<boolean> {
  try {
    const info = await stat(input)
    return info.isFile()
  } catch {
    return false
  }
}
