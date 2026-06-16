import type { AgentId } from './agent.js'
import type { ChatMetadata, ChatMetadataReport } from './chat-metadata.js'

export interface MetadataExportSource {
  provider: AgentId
  report?: ChatMetadataReport
  error?: string
}

export interface MetadataExportSelection {
  provider: AgentId
  chatKey: string
}

export interface BreadcrumbsMetadataExport {
  schemaVersion: 1
  reportType: 'breadcrumbs-metadata-export'
  generatedAt: string
  scope: 'all-providers' | 'chat'
  providers?: MetadataExportSource[]
  chat?: {
    provider: AgentId
    source: ChatMetadataReport['source']
    metadata: ChatMetadata
  }
}

export function createMetadataExport(
  sources: MetadataExportSource[],
  selection?: MetadataExportSelection,
): BreadcrumbsMetadataExport {
  const generatedAt = new Date().toISOString()
  if (!selection) {
    return {
      schemaVersion: 1,
      reportType: 'breadcrumbs-metadata-export',
      generatedAt,
      scope: 'all-providers',
      providers: sources,
    }
  }

  const report = sources.find((source) => source.provider === selection.provider)?.report
  const chat = report?.chats.find((candidate) => candidate.chatKey === selection.chatKey)
  if (!report || !chat) {
    throw new Error('The selected chat is no longer present in the usage index.')
  }
  return {
    schemaVersion: 1,
    reportType: 'breadcrumbs-metadata-export',
    generatedAt,
    scope: 'chat',
    chat: {
      provider: selection.provider,
      source: report.source,
      metadata: chat,
    },
  }
}

export function metadataExportFileName(selection?: MetadataExportSelection): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z')
  return selection
    ? `breadcrumbs-${selection.provider}-chat-${timestamp}.json`
    : `breadcrumbs-metadata-${timestamp}.json`
}
