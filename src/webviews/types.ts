import type { AgentId } from '../agent.js'
import type { ChatDetailReport } from '../chat-detail.js'
import type { ChatMetadataReport } from '../chat-metadata.js'
import type { DiscoveryReport } from '../discovery.js'

export interface ProviderReportResult {
  provider: AgentId
  report?: ChatMetadataReport
  loading?: boolean
  error?: string
}

export interface ReportViewData {
  discovery?: DiscoveryReport
  providers: ProviderReportResult[]
  selectedProvider?: AgentId
  selectedChatKey?: string
  chatDetail?: ChatDetailReport
  chatDetailNavigation?: 'command' | 'none'
  chatDetailContentEnabled?: boolean
}
