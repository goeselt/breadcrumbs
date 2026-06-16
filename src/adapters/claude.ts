import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { claudeChatIdentity } from '../chat-identity.js'
import {
  addTokenUsage,
  durationBetween,
  emptyTokenUsage,
  reportTotals,
  sortChats,
  type ChatMetadata,
  type ChatMetadataReport,
  type TokenUsage,
} from '../chat-metadata.js'
import { findJsonlFiles, numberValue, objectValue, readJsonl, stringValue, type JsonlReadStats } from '../jsonl.js'
import { expandHome, toHomeRelative } from '../path.js'
import { addModelUsage, sortedModels, uniqueStrings } from './shared.js'

export const CLAUDE_TOKEN_SEMANTICS = 'input_plus_cache_creation_plus_cache_read_plus_output' as const

export interface ClaudeMetadataRecord {
  timestamp?: string
  sessionId?: string
  title?: string
  gitBranch?: string
  cwd?: string
  message?: {
    id?: string
    model?: string
    stopReason?: string
    usage: Record<string, unknown>
  }
}

interface ClaudeMessageMetadata {
  model?: string
  usage: TokenUsage
  serviceTier?: string
  inferenceGeo?: string
  speed?: string
  stopReason?: string
  webFetchRequests: number
  webSearchRequests: number
}

export async function readClaudeChatMetadata(rootInput = '~/.claude/projects'): Promise<ChatMetadataReport> {
  const root = expandHome(rootInput)
  const files = await findJsonlFiles(root)
  const chats: ChatMetadata[] = []
  let recordsRead = 0
  let invalidRecords = 0

  for (const file of files) {
    const result = await readClaudeSession(file)
    recordsRead += result.recordsRead
    invalidRecords += result.invalidRecords
    if (result.chat) chats.push(result.chat)
  }

  const sorted = sortChats(chats).filter((chat) => chat.requests > 0)
  const mainChats = sorted.filter((chat) => chat.kind === 'main')
  const hasChildren = mainChats.length !== sorted.length
  return {
    schemaVersion: 2,
    reportType: 'chat-metadata-list',
    provider: 'claude',
    generatedAt: new Date().toISOString(),
    source: {
      path: toHomeRelative(root),
      exists: await pathExists(root),
      filesRead: files.length,
      recordsRead,
      invalidRecords,
      note: files.length === 0 ? 'No Claude project session JSONL files found.' : undefined,
    },
    privacy: {
      contentReadDuringParsing: true,
      contentEmitted: false,
      note: 'JSONL records can contain prompts, responses, and tool results. The adapter emits only allowlisted metadata.',
    },
    totals: reportTotals(mainChats, CLAUDE_TOKEN_SEMANTICS),
    totalsIncludingChildren: hasChildren ? reportTotals(sorted, CLAUDE_TOKEN_SEMANTICS) : undefined,
    chats: sorted,
  }
}

async function readClaudeSession(
  file: string,
): Promise<{ chat?: ChatMetadata; recordsRead: number; invalidRecords: number }> {
  const records: ClaudeMetadataRecord[] = []
  const stats = await readJsonl(file, (record) => {
    const projected = projectClaudeMetadataRecord(record)
    if (projected) records.push(projected)
  })
  return { chat: summarizeClaudeMetadataRecords(file, records, stats), ...stats }
}

export function summarizeClaudeMetadataRecords(
  file: string,
  records: ClaudeMetadataRecord[],
  stats: JsonlReadStats,
): ChatMetadata | undefined {
  let chatId = path.basename(file, '.jsonl')
  let startedAt: string | undefined
  let endedAt: string | undefined
  let title: string | undefined
  let branch: string | undefined
  const workspacePaths = new Set<string>()
  const messages = new Map<string, ClaudeMessageMetadata>()
  let anonymousMessageIndex = 0

  for (const record of records) {
    const { timestamp } = record
    if (timestamp) {
      startedAt = earlierTimestamp(startedAt, timestamp)
      endedAt = laterTimestamp(endedAt, timestamp)
    }
    chatId = record.sessionId ?? chatId
    title = record.title ?? title
    branch = record.gitBranch ?? branch
    const { cwd } = record
    if (cwd) workspacePaths.add(toHomeRelative(cwd))

    const { message } = record
    const usageValue = message?.usage
    if (!message || !usageValue) continue

    const usage = claudeUsage(usageValue)
    if (usage.totalTokens === 0) continue
    const messageId = message.id ?? `(anonymous-${anonymousMessageIndex++})`
    const serverToolUse = objectValue(usageValue, 'server_tool_use')
    messages.set(messageId, {
      model: message.model,
      usage,
      serviceTier: stringValue(usageValue, 'service_tier'),
      inferenceGeo: stringValue(usageValue, 'inference_geo'),
      speed: stringValue(usageValue, 'speed'),
      stopReason: message.stopReason,
      webFetchRequests: numberValue(serverToolUse, 'web_fetch_requests') ?? 0,
      webSearchRequests: numberValue(serverToolUse, 'web_search_requests') ?? 0,
    })
  }

  if (stats.recordsRead === 0) return undefined

  const tokens = emptyTokenUsage(CLAUDE_TOKEN_SEMANTICS)
  const models = new Map<string, ReturnType<typeof sortedModels>[number]>()
  let webFetchRequests = 0
  let webSearchRequests = 0
  const serviceTiers = new Set<string>()
  const inferenceGeos = new Set<string>()
  const speeds = new Set<string>()
  const stopReasons = new Map<string, number>()

  for (const message of messages.values()) {
    addTokenUsage(tokens, message.usage)
    addModelUsage(models, message.model, message.usage)
    webFetchRequests += message.webFetchRequests
    webSearchRequests += message.webSearchRequests
    if (message.serviceTier) serviceTiers.add(message.serviceTier)
    if (message.inferenceGeo) inferenceGeos.add(message.inferenceGeo)
    if (message.speed) speeds.add(message.speed)
    if (message.stopReason) stopReasons.set(message.stopReason, (stopReasons.get(message.stopReason) ?? 0) + 1)
  }

  const chat: ChatMetadata = {
    provider: 'claude',
    ...claudeChatIdentity(chatId, file),
    chatId,
    sourcePath: toHomeRelative(file, homedir()),
    title,
    startedAt,
    endedAt,
    wallClockDurationMs: durationBetween(startedAt, endedAt),
    workspacePaths: uniqueStrings(workspacePaths),
    branch,
    requests: messages.size,
    models: sortedModels(models),
    tokens,
    billing: {
      status: 'unavailable',
      note: 'Claude session JSONL does not expose a provider-reported per-chat cost or credit value.',
    },
    providerMetadata: {
      agentId: file.includes(`${path.sep}subagents${path.sep}`) ? path.basename(file, '.jsonl') : undefined,
      serviceTiers: [...serviceTiers].sort(),
      inferenceGeos: [...inferenceGeos].sort(),
      speeds: [...speeds].sort(),
      stopReasons: Object.fromEntries([...stopReasons.entries()].sort()),
      serverToolUse: {
        webFetchRequests,
        webSearchRequests,
      },
    },
    dataQuality: {
      confidence: 'high',
      deduplication: 'Repeated streaming snapshots are collapsed by message.id; the latest snapshot wins.',
      caveats: [
        'Wall-clock duration spans the first and last local record and may include user idle time.',
        'The local session format has no reliable per-request duration.',
      ],
    },
  }

  return chat
}

export function projectClaudeMetadataRecord(record: Record<string, unknown>): ClaudeMetadataRecord | undefined {
  const message = objectValue(record, 'message')
  const usage = objectValue(message, 'usage')
  const projected: ClaudeMetadataRecord = {
    timestamp: stringValue(record, 'timestamp'),
    sessionId: stringValue(record, 'sessionId'),
    title: stringValue(record, 'aiTitle'),
    gitBranch: stringValue(record, 'gitBranch'),
    cwd: stringValue(record, 'cwd'),
    message:
      message && usage
        ? {
            id: stringValue(message, 'id'),
            model: stringValue(message, 'model'),
            stopReason: stringValue(message, 'stop_reason'),
            usage: projectClaudeUsage(usage),
          }
        : undefined,
  }
  return Object.values(projected).some((value) => value !== undefined) ? projected : undefined
}

function projectClaudeUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const serverToolUse = objectValue(usage, 'server_tool_use')
  return compactObject({
    input_tokens: numberValue(usage, 'input_tokens'),
    output_tokens: numberValue(usage, 'output_tokens'),
    cache_creation_input_tokens: numberValue(usage, 'cache_creation_input_tokens'),
    cache_read_input_tokens: numberValue(usage, 'cache_read_input_tokens'),
    service_tier: stringValue(usage, 'service_tier'),
    inference_geo: stringValue(usage, 'inference_geo'),
    speed: stringValue(usage, 'speed'),
    server_tool_use: serverToolUse
      ? compactObject({
          web_fetch_requests: numberValue(serverToolUse, 'web_fetch_requests'),
          web_search_requests: numberValue(serverToolUse, 'web_search_requests'),
        })
      : undefined,
  })
}

function claudeUsage(value: Record<string, unknown>): TokenUsage {
  const inputTokens = numberValue(value, 'input_tokens') ?? 0
  const cacheCreationInputTokens = numberValue(value, 'cache_creation_input_tokens') ?? 0
  const cachedInputTokens = numberValue(value, 'cache_read_input_tokens') ?? 0
  const outputTokens = numberValue(value, 'output_tokens') ?? 0
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + cacheCreationInputTokens + cachedInputTokens + outputTokens,
    totalTokenSemantics: CLAUDE_TOKEN_SEMANTICS,
  }
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

async function pathExists(input: string): Promise<boolean> {
  try {
    await stat(input)
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    )
      return false
    throw error
  }
}

function earlierTimestamp(current: string | undefined, next: string): string {
  return !current || Date.parse(next) < Date.parse(current) ? next : current
}

function laterTimestamp(current: string | undefined, next: string): string {
  return !current || Date.parse(next) > Date.parse(current) ? next : current
}
