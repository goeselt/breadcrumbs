import { stat } from 'node:fs/promises'
import type { AgentId } from '../agent.js'
import type { ChatDetailOptions, ChatDetailReport } from '../chat-detail.js'
import type { ChatMetadata, ChatMetadataReport, TokenSemantics } from '../chat-metadata.js'
import { findJsonlFiles, type JsonlReadStats } from '../jsonl.js'
import { readClaudeChatDetail } from './claude-detail.js'
import {
  CLAUDE_TOKEN_SEMANTICS,
  projectClaudeMetadataRecord,
  summarizeClaudeMetadataRecords,
  type ClaudeMetadataRecord,
} from './claude.js'
import { readCodexChatDetail } from './codex-detail.js'
import { applyCodexTitles } from './codex-titles.js'
import {
  CODEX_TOKEN_SEMANTICS,
  projectCodexMetadataRecord,
  summarizeCodexMetadataRecords,
  type CodexMetadataRecord,
} from './codex.js'
import { readCopilotChatDetail } from './copilot-detail.js'
import {
  COPILOT_TOKEN_SEMANTICS,
  projectCopilotMetadataRecord,
  summarizeCopilotMetadataRecords,
  type CopilotMetadataRecord,
} from './copilot.js'
import {
  COPILOT_TRACE_PARSER_VERSION,
  COPILOT_TRACE_SOURCE_FORMAT,
  findCopilotTraceDatabase,
  readCopilotTraceDetail,
  readCopilotTraceMetadata,
} from './copilot-traces.js'

export const SOURCE_FORMATS = {
  copilotOtelJsonl: 'copilot-otel-jsonl',
  copilotTraceSqlite: COPILOT_TRACE_SOURCE_FORMAT,
  codexSessionJsonl: 'codex-session-jsonl',
  claudeProjectJsonl: 'claude-project-jsonl',
} as const

export type SourceFormat = (typeof SOURCE_FORMATS)[keyof typeof SOURCE_FORMATS]

export interface JsonlProviderSource<T = unknown> {
  readonly sourceFormat: SourceFormat
  readonly parserVersion: number
  readonly defaultSource: string
  listFiles(source: string): Promise<string[]>
  project(record: Record<string, unknown>): T | undefined
  summarize(file: string, records: T[], stats: JsonlReadStats): ChatMetadata[]
  afterSummarize?(chats: ChatMetadata[], source: string): Promise<ChatMetadata[]> | ChatMetadata[]
}

export interface DirectProviderSource {
  readonly sourceFormat: SourceFormat
  readonly parserVersion: number
  readonly fallbackOnError: boolean
  find(): Promise<string | undefined>
  read(source: string): Promise<ChatMetadataReport>
}

export interface ProviderAdapter {
  readonly provider: AgentId
  readonly tokenSemantics: TokenSemantics
  readonly jsonlSource: JsonlProviderSource
  readonly directSources?: readonly DirectProviderSource[]
  readIndexedDetail(metadata: ChatMetadata, options?: ChatDetailOptions): Promise<ChatDetailReport>
  readDetail(chatReference: string, options?: ChatDetailOptions, source?: string): Promise<ChatDetailReport>
}

const JSONL_PARSER_VERSION = 2

const PROVIDERS: Record<AgentId, ProviderAdapter> = {
  copilot: {
    provider: 'copilot',
    tokenSemantics: COPILOT_TOKEN_SEMANTICS,
    jsonlSource: {
      sourceFormat: SOURCE_FORMATS.copilotOtelJsonl,
      parserVersion: JSONL_PARSER_VERSION,
      defaultSource: '~/.cache/vscode-chat-token-usage/copilot-otel.jsonl',
      listFiles: async (source) => ((await isFile(source)) ? [source] : []),
      project: projectCopilotMetadataRecord,
      summarize: (file, records) => summarizeCopilotMetadataRecords(records as CopilotMetadataRecord[], file),
    },
    directSources: [
      {
        sourceFormat: SOURCE_FORMATS.copilotTraceSqlite,
        parserVersion: COPILOT_TRACE_PARSER_VERSION,
        fallbackOnError: true,
        find: findCopilotTraceDatabase,
        read: readCopilotTraceMetadata,
      },
    ],
    readIndexedDetail: (metadata, options) =>
      metadata.providerMetadata.sourceFormat === SOURCE_FORMATS.copilotTraceSqlite
        ? readCopilotTraceDetail(metadata, options)
        : readCopilotChatDetail(metadata.chatKey, options, metadata.sourcePath, metadata),
    readDetail: (chatReference, options, source) => readCopilotChatDetail(chatReference, options, source),
  },
  codex: {
    provider: 'codex',
    tokenSemantics: CODEX_TOKEN_SEMANTICS,
    jsonlSource: {
      sourceFormat: SOURCE_FORMATS.codexSessionJsonl,
      parserVersion: JSONL_PARSER_VERSION,
      defaultSource: '~/.codex/sessions',
      listFiles: findJsonlFiles,
      project: projectCodexMetadataRecord,
      summarize: (file, records, stats) =>
        summarizeOptional(summarizeCodexMetadataRecords(file, records as CodexMetadataRecord[], stats)),
      afterSummarize: applyCodexTitles,
    },
    readIndexedDetail: (metadata, options) =>
      readCodexChatDetail(metadata.chatKey, options, metadata.sourcePath, metadata),
    readDetail: (chatReference, options, source) => readCodexChatDetail(chatReference, options, source),
  },
  claude: {
    provider: 'claude',
    tokenSemantics: CLAUDE_TOKEN_SEMANTICS,
    jsonlSource: {
      sourceFormat: SOURCE_FORMATS.claudeProjectJsonl,
      parserVersion: JSONL_PARSER_VERSION,
      defaultSource: '~/.claude/projects',
      listFiles: findJsonlFiles,
      project: projectClaudeMetadataRecord,
      summarize: (file, records, stats) =>
        summarizeOptional(summarizeClaudeMetadataRecords(file, records as ClaudeMetadataRecord[], stats)),
    },
    readIndexedDetail: (metadata, options) =>
      readClaudeChatDetail(metadata.chatKey, options, metadata.sourcePath, metadata),
    readDetail: (chatReference, options, source) => readClaudeChatDetail(chatReference, options, source),
  },
}

export function providerAdapter(provider: AgentId): ProviderAdapter {
  return PROVIDERS[provider]
}

function summarizeOptional(chat: ChatMetadata | undefined): ChatMetadata[] {
  return chat ? [chat] : []
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
