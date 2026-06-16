import type { AgentId } from './agent.js'
import type { ChatIdentity } from './chat-identity.js'
import type { ParserDiagnostics } from './index/jsonl-index.js'

export interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  totalTokenSemantics: string
}

export interface ModelUsage extends TokenUsage {
  model: string
  requests: number
  durationMs?: number
}

export interface ToolUsage {
  calls: number
  durationMs?: number
  byTool: Array<{
    tool: string
    calls: number
    durationMs?: number
  }>
}

export interface BillingMetadata {
  status: 'provider-reported' | 'unavailable'
  credits?: number
  costUsd?: number
  note?: string
}

export interface ChatMetadata extends ChatIdentity {
  provider: AgentId
  /** @deprecated Use providerChatId for provider data or chatKey for application identity. */
  chatId: string
  sourcePath: string
  title?: string
  startedAt?: string
  endedAt?: string
  wallClockDurationMs?: number
  workspacePaths: string[]
  repositoryUrl?: string
  branch?: string
  requests: number
  turns?: number
  models: ModelUsage[]
  tokens: TokenUsage
  modelContextWindow?: number
  performance?: {
    modelDurationMs?: number
    averageTimeToFirstTokenMs?: number
  }
  tools?: ToolUsage
  billing: BillingMetadata
  providerMetadata: Record<string, unknown>
  dataQuality: {
    confidence: 'high' | 'medium' | 'low'
    deduplication: string
    caveats: string[]
  }
}

export interface ChatMetadataReport {
  schemaVersion: 2
  reportType: 'chat-metadata-list'
  provider: AgentId
  generatedAt: string
  source: {
    path: string
    exists: boolean
    filesRead: number
    recordsRead: number
    invalidRecords: number
    note?: string
  }
  privacy: {
    contentReadDuringParsing: boolean
    contentEmitted: false
    note: string
  }
  index?: {
    storagePath: string
    files: Array<{
      sourceId: string
      sourcePath: string
      mode: 'unchanged' | 'append' | 'rebuild' | 'stale'
      appendedRecords: number
      parserVersion: number
      sourceFormat: string
      diagnostics: ParserDiagnostics
      warning?: string
    }>
  }
  totals: {
    chats: number
    requests: number
    turns?: number
    wallClockDurationMs: number
    modelDurationMs?: number
    tokens: TokenUsage
    models: ModelUsage[]
  }
  totalsIncludingChildren?: ChatMetadataReport['totals']
  chats: ChatMetadata[]
}

export type TokenSemantics =
  | 'input_plus_output; cached_input_is_a_subset_of_input'
  | 'input_plus_output; cache_fields_are_reported_separately'
  | 'input_plus_cache_creation_plus_cache_read_plus_output'

export function emptyTokenUsage(totalTokenSemantics: TokenSemantics): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    totalTokenSemantics,
  }
}

export function addTokenUsage(target: TokenUsage, source: TokenUsage): void {
  target.inputTokens += source.inputTokens
  target.cachedInputTokens += source.cachedInputTokens
  target.cacheCreationInputTokens += source.cacheCreationInputTokens
  target.outputTokens += source.outputTokens
  target.reasoningOutputTokens += source.reasoningOutputTokens
  target.totalTokens += source.totalTokens
}

export function subtractTokenUsage(current: TokenUsage, previous: TokenUsage): TokenUsage {
  return {
    inputTokens: positiveDelta(current.inputTokens, previous.inputTokens),
    cachedInputTokens: positiveDelta(current.cachedInputTokens, previous.cachedInputTokens),
    cacheCreationInputTokens: positiveDelta(current.cacheCreationInputTokens, previous.cacheCreationInputTokens),
    outputTokens: positiveDelta(current.outputTokens, previous.outputTokens),
    reasoningOutputTokens: positiveDelta(current.reasoningOutputTokens, previous.reasoningOutputTokens),
    totalTokens: positiveDelta(current.totalTokens, previous.totalTokens),
    totalTokenSemantics: current.totalTokenSemantics,
  }
}

export function durationBetween(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (!startedAt || !endedAt) return undefined
  const duration = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

export function sortChats(chats: ChatMetadata[]): ChatMetadata[] {
  return chats.slice().sort((a, b) => {
    const timeDifference = Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '')
    if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference
    return a.chatKey.localeCompare(b.chatKey)
  })
}

export function resolveChatReference(chats: ChatMetadata[], reference: string): { chat?: ChatMetadata; note?: string } {
  const byKey = chats.find((chat) => chat.chatKey === reference)
  if (byKey) return { chat: byKey }

  const byProviderId = chats.filter((chat) => chat.providerChatId === reference || chat.chatId === reference)
  if (byProviderId.length === 1) return { chat: byProviderId[0] }
  if (byProviderId.length > 1) {
    return {
      note: `Chat ID "${reference}" is ambiguous across ${byProviderId.length} source files. Use chatKey instead.`,
    }
  }
  return { note: `Chat reference "${reference}" was not found.` }
}

export function reportTotals(chats: ChatMetadata[], semantics: TokenSemantics): ChatMetadataReport['totals'] {
  const tokens = emptyTokenUsage(semantics)
  const models = new Map<string, ModelUsage>()
  let requests = 0
  let turns = 0
  let hasTurns = false
  let wallClockDurationMs = 0
  let modelDurationMs = 0
  let hasModelDuration = false

  for (const chat of chats) {
    requests += chat.requests
    if (chat.turns !== undefined) {
      turns += chat.turns
      hasTurns = true
    }
    wallClockDurationMs += chat.wallClockDurationMs ?? 0
    if (chat.performance?.modelDurationMs !== undefined) {
      modelDurationMs += chat.performance.modelDurationMs
      hasModelDuration = true
    }
    addTokenUsage(tokens, chat.tokens)

    for (const model of chat.models) {
      const aggregate = models.get(model.model) ?? {
        model: model.model,
        requests: 0,
        ...emptyTokenUsage(semantics),
      }
      aggregate.requests += model.requests
      addTokenUsage(aggregate, model)
      if (model.durationMs !== undefined) aggregate.durationMs = (aggregate.durationMs ?? 0) + model.durationMs
      models.set(model.model, aggregate)
    }
  }

  return {
    chats: chats.length,
    requests,
    turns: hasTurns ? turns : undefined,
    wallClockDurationMs,
    modelDurationMs: hasModelDuration ? modelDurationMs : undefined,
    tokens,
    models: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)),
  }
}

function positiveDelta(current: number, previous: number): number {
  return Math.max(0, current - previous)
}
