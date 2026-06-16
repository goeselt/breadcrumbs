import type { AgentId } from './agent.js'
import type { ChatMetadata, TokenUsage } from './chat-metadata.js'

export type ContentMode = 'none' | 'messages' | 'tools' | 'all'

export type ChatDetailEventKind =
  | 'session'
  | 'turn'
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'model_request'
  | 'tool_call'
  | 'tool_result'
  | 'attachment'
  | 'other'

export interface ContentExcerpt {
  originalChars: number
  emittedChars: number
  truncated: boolean
  text?: string
  omittedReason?: string
}

export interface ChatContextEntry {
  kind: string
  label: string
  source?: string
  content?: ContentExcerpt
  details?: Record<string, unknown>
}

export interface ChatDetailEvent {
  index?: number
  timestamp?: string
  kind: ChatDetailEventKind
  id?: string
  parentId?: string
  turnId?: string
  requestId?: string
  role?: string
  model?: string
  toolName?: string
  toolCallId?: string
  durationMs?: number
  timeToFirstTokenMs?: number
  success?: boolean
  usage?: TokenUsage
  content?: ContentExcerpt
  details?: Record<string, unknown>
}

export interface ChatDetailOptions {
  contentMode?: ContentMode
  maxContentChars?: number
  maxEvents?: number
}

export interface ResolvedChatDetailOptions {
  contentMode: ContentMode
  maxContentChars: number
  maxEvents: number
}

export interface ChatDetailReport {
  schemaVersion: 2
  reportType: 'chat-detail'
  provider: AgentId
  chatKey?: string
  providerChatId?: string
  /** @deprecated Use providerChatId for provider data or chatKey for application identity. */
  chatId: string
  generatedAt: string
  found: boolean
  source?: {
    path: string
    recordsRead: number
    invalidRecords: number
  }
  privacy: {
    contentMode: ContentMode
    contentEmitted: boolean
    maxContentCharsPerField: number
    warning: string
  }
  metadata?: ChatMetadata
  summary?: {
    timelineEvents: number
    emittedTimelineEvents: number
    omittedTimelineEvents: number
    contextEntries: number
    eventKinds: Record<string, number>
    contentCharsObserved: number
    contentCharsEmitted: number
  }
  context: ChatContextEntry[]
  timeline: ChatDetailEvent[]
  note?: string
}

export function resolveChatDetailOptions(options: ChatDetailOptions = {}): ResolvedChatDetailOptions {
  return {
    contentMode: options.contentMode ?? 'none',
    maxContentChars: positiveInteger(options.maxContentChars, 1_000),
    maxEvents: positiveInteger(options.maxEvents, 1_000),
  }
}

export function contentExcerpt(
  value: unknown,
  allowed: boolean,
  options: ResolvedChatDetailOptions,
  omittedReason: string,
): ContentExcerpt | undefined {
  const text = contentText(value)
  if (text === undefined) return undefined
  if (!allowed) {
    return {
      originalChars: text.length,
      emittedChars: 0,
      truncated: false,
      omittedReason,
    }
  }

  const truncated = text.length > options.maxContentChars
  const emitted = truncated ? text.slice(0, options.maxContentChars) : text
  return {
    originalChars: text.length,
    emittedChars: emitted.length,
    truncated,
    text: emitted,
  }
}

export function finalizeChatDetailReport(
  report: Omit<ChatDetailReport, 'summary' | 'privacy'> & {
    options: ResolvedChatDetailOptions
  },
): ChatDetailReport {
  const timeline = report.timeline
    .slice()
    .sort((a, b) => timestampValue(a.timestamp) - timestampValue(b.timestamp))
    .map((event, index) => ({ ...event, index }))
  const eventKinds: Record<string, number> = {}
  let contentCharsObserved = 0
  let contentCharsEmitted = 0

  for (const event of timeline) {
    eventKinds[event.kind] = (eventKinds[event.kind] ?? 0) + 1
    contentCharsObserved += event.content?.originalChars ?? 0
    contentCharsEmitted += event.content?.emittedChars ?? 0
  }
  for (const entry of report.context) {
    contentCharsObserved += entry.content?.originalChars ?? 0
    contentCharsEmitted += entry.content?.emittedChars ?? 0
  }

  const cappedTimeline = capTimeline(timeline, report.options.maxEvents)
  return {
    schemaVersion: report.schemaVersion,
    reportType: report.reportType,
    provider: report.provider,
    chatKey: report.chatKey,
    providerChatId: report.providerChatId,
    chatId: report.chatId,
    generatedAt: report.generatedAt,
    found: report.found,
    source: report.source,
    privacy: {
      contentMode: report.options.contentMode,
      contentEmitted: contentCharsEmitted > 0,
      maxContentCharsPerField: report.options.maxContentChars,
      warning:
        report.options.contentMode === 'none'
          ? 'Content is suppressed. Use --content messages, tools, or all only for trusted local output.'
          : report.options.contentMode === 'messages'
            ? 'This report can contain prompts, responses, source code, paths, and secrets.'
            : report.options.contentMode === 'tools'
              ? 'This report can contain commands, paths, source code, secrets, and tool output.'
              : 'This report can contain prompts, responses, source code, paths, commands, secrets, and tool output.',
    },
    metadata: report.metadata,
    summary: report.found
      ? {
          timelineEvents: timeline.length,
          emittedTimelineEvents: cappedTimeline.length,
          omittedTimelineEvents: timeline.length - cappedTimeline.length,
          contextEntries: report.context.length,
          eventKinds,
          contentCharsObserved,
          contentCharsEmitted,
        }
      : undefined,
    context: report.context,
    timeline: cappedTimeline,
    note: report.note,
  }
}

export function emptyChatDetailReport(
  provider: AgentId,
  chatId: string,
  options: ResolvedChatDetailOptions,
  note: string,
): ChatDetailReport {
  return finalizeChatDetailReport({
    schemaVersion: 2,
    reportType: 'chat-detail',
    provider,
    chatId,
    generatedAt: new Date().toISOString(),
    found: false,
    context: [],
    timeline: [],
    options,
    note,
  })
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function capTimeline(timeline: ChatDetailEvent[], limit: number): ChatDetailEvent[] {
  if (timeline.length <= limit) return timeline
  const firstCount = Math.ceil(limit / 2)
  const lastCount = Math.floor(limit / 2)
  return [...timeline.slice(0, firstCount), ...timeline.slice(timeline.length - lastCount)]
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback
}

function timestampValue(timestamp: string | undefined): number {
  if (!timestamp) return Number.MAX_SAFE_INTEGER
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}
