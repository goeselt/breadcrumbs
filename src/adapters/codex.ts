import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { mainChatIdentity } from '../chat-identity.js'
import {
  addTokenUsage,
  durationBetween,
  emptyTokenUsage,
  reportTotals,
  sortChats,
  subtractTokenUsage,
  type ChatMetadata,
  type ChatMetadataReport,
  type TokenUsage,
} from '../chat-metadata.js'
import { findJsonlFiles, numberValue, objectValue, readJsonl, stringValue, type JsonlReadStats } from '../jsonl.js'
import { expandHome, toHomeRelative } from '../path.js'
import { addModelUsage, sortedModels, uniqueStrings } from './shared.js'
import { applyCodexTitles } from './codex-titles.js'

export const CODEX_TOKEN_SEMANTICS = 'input_plus_output; cached_input_is_a_subset_of_input' as const

export interface CodexMetadataRecord {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
}

export async function readCodexChatMetadata(rootInput = '~/.codex/sessions'): Promise<ChatMetadataReport> {
  const root = expandHome(rootInput)
  const files = await findJsonlFiles(root)
  const chats: ChatMetadata[] = []
  let recordsRead = 0
  let invalidRecords = 0

  for (const file of files) {
    const result = await readCodexSession(file)
    recordsRead += result.recordsRead
    invalidRecords += result.invalidRecords
    if (result.chat) chats.push(result.chat)
  }

  const sorted = sortChats(await applyCodexTitles(chats, root)).filter((chat) => chat.requests > 0)
  return {
    schemaVersion: 2,
    reportType: 'chat-metadata-list',
    provider: 'codex',
    generatedAt: new Date().toISOString(),
    source: {
      path: toHomeRelative(root),
      exists: await pathExists(root),
      filesRead: files.length,
      recordsRead,
      invalidRecords,
      note: files.length === 0 ? 'No Codex session JSONL files found.' : undefined,
    },
    privacy: {
      contentReadDuringParsing: true,
      contentEmitted: false,
      note: 'JSONL records can contain prompts and responses. The adapter emits only allowlisted metadata.',
    },
    totals: reportTotals(sorted, CODEX_TOKEN_SEMANTICS),
    chats: sorted,
  }
}

async function readCodexSession(
  file: string,
): Promise<{ chat?: ChatMetadata; recordsRead: number; invalidRecords: number }> {
  const records: CodexMetadataRecord[] = []
  const stats = await readJsonl(file, (record) => {
    const projected = projectCodexMetadataRecord(record)
    if (projected) records.push(projected)
  })
  return { chat: summarizeCodexMetadataRecords(file, records, stats), ...stats }
}

export function summarizeCodexMetadataRecords(
  file: string,
  records: CodexMetadataRecord[],
  stats: JsonlReadStats,
): ChatMetadata | undefined {
  let chatId = path.basename(file, '.jsonl')
  let startedAt: string | undefined
  let endedAt: string | undefined
  let repositoryUrl: string | undefined
  let branch: string | undefined
  let provider: string | undefined
  let currentModel: string | undefined
  let modelContextWindow: number | undefined
  let previousTotal = emptyTokenUsage(CODEX_TOKEN_SEMANTICS)
  const accumulatedTotal = emptyTokenUsage(CODEX_TOKEN_SEMANTICS)
  let hasUsage = false
  let credits: number | undefined
  let planType: string | undefined
  let primaryRateLimit: Record<string, unknown> | undefined
  let secondaryRateLimit: Record<string, unknown> | undefined
  const workspacePaths = new Set<string>()
  const models = new Map<string, ReturnType<typeof sortedModels>[number]>()
  const turnModels = new Map<string, string>()
  const turnDurations = new Map<string, { durationMs?: number; timeToFirstTokenMs?: number }>()
  const turns = new Set<string>()

  for (const record of records) {
    const { timestamp } = record
    if (timestamp) {
      startedAt = earlierTimestamp(startedAt, timestamp)
      endedAt = laterTimestamp(endedAt, timestamp)
    }

    const { type } = record
    const { payload } = record
    if (!payload) continue

    if (type === 'session_meta') {
      chatId = stringValue(payload, 'id') ?? chatId
      provider = stringValue(payload, 'model_provider') ?? provider
      const cwd = stringValue(payload, 'cwd')
      if (cwd) workspacePaths.add(toHomeRelative(cwd))
      const git = objectValue(payload, 'git')
      repositoryUrl = stringValue(git, 'repository_url') ?? repositoryUrl
      branch = stringValue(git, 'branch') ?? branch
    }

    if (type === 'turn_context') {
      const turnId = stringValue(payload, 'turn_id')
      const collaborationSettings = objectValue(objectValue(payload, 'collaboration_mode'), 'settings')
      currentModel = stringValue(payload, 'model') ?? stringValue(collaborationSettings, 'model') ?? currentModel
      const cwd = stringValue(payload, 'cwd')
      if (cwd) workspacePaths.add(toHomeRelative(cwd))
      if (turnId) {
        turns.add(turnId)
        if (currentModel) turnModels.set(turnId, currentModel)
      }
    }

    const info = objectValue(payload, 'info')
    const nextTotal = codexUsage(objectValue(info, 'total_token_usage'))
    modelContextWindow =
      numberValue(info, 'model_context_window') ?? numberValue(payload, 'model_context_window') ?? modelContextWindow
    if (nextTotal) {
      const delta =
        hasUsage && nextTotal.totalTokens < previousTotal.totalTokens
          ? nextTotal
          : subtractTokenUsage(nextTotal, previousTotal)
      if (delta.totalTokens > 0) addModelUsage(models, currentModel, delta)
      addTokenUsage(accumulatedTotal, delta)
      previousTotal = nextTotal
      hasUsage = true
    }

    const turnId = stringValue(payload, 'turn_id')
    const durationMs = numberValue(payload, 'duration_ms')
    const timeToFirstTokenMs = numberValue(payload, 'time_to_first_token_ms')
    if (turnId && (durationMs !== undefined || timeToFirstTokenMs !== undefined)) {
      turns.add(turnId)
      turnDurations.set(turnId, { durationMs, timeToFirstTokenMs })
    }

    const rateLimits = objectValue(payload, 'rate_limits')
    if (rateLimits) {
      credits = numberValue(rateLimits, 'credits') ?? credits
      planType = stringValue(rateLimits, 'plan_type') ?? planType
      primaryRateLimit = objectValue(rateLimits, 'primary') ?? primaryRateLimit
      secondaryRateLimit = objectValue(rateLimits, 'secondary') ?? secondaryRateLimit
    }
  }

  if (stats.recordsRead === 0) return undefined

  let modelDurationMs = 0
  let hasModelDuration = false
  const timeToFirstTokenValues: number[] = []
  for (const [turnId, timing] of turnDurations) {
    if (timing.durationMs !== undefined) {
      modelDurationMs += timing.durationMs
      hasModelDuration = true
      const model = models.get(turnModels.get(turnId) ?? '(unknown)')
      if (model) model.durationMs = (model.durationMs ?? 0) + timing.durationMs
    }
    if (timing.timeToFirstTokenMs !== undefined) timeToFirstTokenValues.push(timing.timeToFirstTokenMs)
  }

  const chat: ChatMetadata = {
    provider: 'codex',
    ...mainChatIdentity('codex', chatId, file),
    chatId,
    sourcePath: toHomeRelative(file, homedir()),
    startedAt,
    endedAt,
    wallClockDurationMs: durationBetween(startedAt, endedAt),
    workspacePaths: uniqueStrings(workspacePaths),
    repositoryUrl,
    branch,
    requests: [...models.values()].reduce((sum, model) => sum + model.requests, 0),
    turns: turns.size,
    models: sortedModels(models),
    tokens: hasUsage ? accumulatedTotal : emptyTokenUsage(CODEX_TOKEN_SEMANTICS),
    modelContextWindow,
    performance:
      hasModelDuration || timeToFirstTokenValues.length > 0
        ? {
            modelDurationMs: hasModelDuration ? modelDurationMs : undefined,
            averageTimeToFirstTokenMs: average(timeToFirstTokenValues),
          }
        : undefined,
    billing:
      credits === undefined
        ? {
            status: 'unavailable',
            note: 'Codex exposed rate-limit state but no numeric credit value in this session.',
          }
        : { status: 'provider-reported', credits },
    providerMetadata: {
      modelProvider: provider,
      planType,
      primaryRateLimit: normalizeRateLimit(primaryRateLimit),
      secondaryRateLimit: normalizeRateLimit(secondaryRateLimit),
    },
    dataQuality: {
      confidence: 'high',
      deduplication:
        'Cumulative usage snapshots are converted to positive deltas; a decreasing total starts a new counter segment.',
      caveats: [
        'Model duration is reported per completed turn, not necessarily pure network inference time.',
        'Rate-limit percentages are snapshots and cannot be converted into per-chat credits.',
      ],
    },
  }

  return chat
}

export function projectCodexMetadataRecord(record: Record<string, unknown>): CodexMetadataRecord | undefined {
  const payload = objectValue(record, 'payload')
  const info = objectValue(payload, 'info')
  const collaborationMode = objectValue(payload, 'collaboration_mode')
  const collaborationSettings = objectValue(collaborationMode, 'settings')
  const git = objectValue(payload, 'git')
  const rateLimits = objectValue(payload, 'rate_limits')
  const projectedPayload = payload
    ? compactObject({
        id: stringValue(payload, 'id'),
        model_provider: stringValue(payload, 'model_provider'),
        cwd: stringValue(payload, 'cwd'),
        git: git
          ? compactObject({
              repository_url: stringValue(git, 'repository_url'),
              branch: stringValue(git, 'branch'),
            })
          : undefined,
        turn_id: stringValue(payload, 'turn_id'),
        model: stringValue(payload, 'model'),
        collaboration_mode: collaborationMode
          ? {
              settings: compactObject({ model: stringValue(collaborationSettings, 'model') }),
            }
          : undefined,
        info: info
          ? compactObject({
              total_token_usage: projectCodexUsage(objectValue(info, 'total_token_usage')),
              model_context_window: numberValue(info, 'model_context_window'),
            })
          : undefined,
        model_context_window: numberValue(payload, 'model_context_window'),
        duration_ms: numberValue(payload, 'duration_ms'),
        time_to_first_token_ms: numberValue(payload, 'time_to_first_token_ms'),
        rate_limits: rateLimits ? projectRateLimits(rateLimits) : undefined,
      })
    : undefined
  const projected: CodexMetadataRecord = {
    timestamp: stringValue(record, 'timestamp'),
    type: stringValue(record, 'type'),
    payload: projectedPayload,
  }
  return Object.values(projected).some((value) => value !== undefined) ? projected : undefined
}

function projectCodexUsage(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  return compactObject({
    input_tokens: numberValue(value, 'input_tokens'),
    cached_input_tokens: numberValue(value, 'cached_input_tokens'),
    output_tokens: numberValue(value, 'output_tokens'),
    reasoning_output_tokens: numberValue(value, 'reasoning_output_tokens'),
    total_tokens: numberValue(value, 'total_tokens'),
  })
}

function projectRateLimits(value: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    credits: numberValue(value, 'credits'),
    plan_type: stringValue(value, 'plan_type'),
    primary: projectRateLimit(objectValue(value, 'primary')),
    secondary: projectRateLimit(objectValue(value, 'secondary')),
  })
}

function projectRateLimit(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  return compactObject({
    used_percent: numberValue(value, 'used_percent'),
    window_minutes: numberValue(value, 'window_minutes'),
    resets_at: numberValue(value, 'resets_at'),
  })
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
    totalTokenSemantics: CODEX_TOKEN_SEMANTICS,
  }
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function normalizeRateLimit(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  const resetsAt = numberValue(value, 'resets_at')
  return {
    usedPercent: numberValue(value, 'used_percent'),
    windowMinutes: numberValue(value, 'window_minutes'),
    resetsAt: resetsAt === undefined ? undefined : new Date(resetsAt * 1000).toISOString(),
  }
}

async function pathExists(input: string): Promise<boolean> {
  try {
    await stat(input)
    return true
  } catch {
    return false
  }
}

function average(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length
}

function earlierTimestamp(current: string | undefined, next: string): string {
  return !current || Date.parse(next) < Date.parse(current) ? next : current
}

function laterTimestamp(current: string | undefined, next: string): string {
  return !current || Date.parse(next) > Date.parse(current) ? next : current
}
