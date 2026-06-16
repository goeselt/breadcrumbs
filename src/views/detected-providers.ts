import type { AgentId } from '../agent.js'
import type { DiscoveryReport } from '../discovery.js'
import type { ProviderReportResult } from '../webviews/report-html.js'
import type { DetectedProviderItem } from './report-tree.js'

export function detectedProviderItems(
  discovery: DiscoveryReport,
  reports: Map<AgentId, ProviderReportResult>,
): DetectedProviderItem[] {
  return discovery.agents.map((agent) => {
    const indexed = reports.get(agent.agent.id)?.report
    const loading = reports.get(agent.agent.id)?.loading
    const chatCount = indexed?.totals.chats
    const description = loading
      ? 'Loading...'
      : chatCount !== undefined
        ? `${formatNumber(chatCount)} ${chatCount === 1 ? 'chat' : 'chats'}`
        : readinessLabel(agent.readiness.analysis.status)
    return {
      provider: agent.agent.id,
      label: agent.agent.label,
      description,
    }
  })
}

function readinessLabel(status: 'ready' | 'partial' | 'unavailable'): string {
  if (status === 'ready') return 'Ready'
  if (status === 'partial') return 'Partial'
  return 'Unavailable'
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}
