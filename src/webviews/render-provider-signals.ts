import type { AgentId } from '../agent.js'
import type { ChatMetadata, ChatMetadataReport } from '../chat-metadata.js'
import {
  averageDefined,
  formatDuration,
  formatNumber,
  formatOptionalNumber,
  formatPercent,
  maxDefined,
  sum,
} from './render-primitives.js'
import type { ProviderSignal } from './render-shared.js'

export function providerSignalTitle(provider: AgentId): string {
  if (provider === 'copilot') return 'Copilot activity'
  if (provider === 'codex') return 'Codex execution'
  return 'Claude activity'
}

/** Provider-specific activity facts shown beneath the usage charts in the provider overview. */
export function providerSignals(provider: AgentId, report: ChatMetadataReport): ProviderSignal[] {
  if (provider === 'copilot') {
    return [
      { label: 'Turns', value: formatOptionalNumber(report.totals.turns) },
      { label: 'Tool calls', value: formatNumber(sum(report.chats.map((chat) => chat.tools?.calls ?? 0))) },
      { label: 'Tools', value: aggregateToolNames(report.chats) },
      { label: 'Agent names', value: metadataStrings(report.chats, 'agentNames') },
      { label: 'Agent types', value: metadataStrings(report.chats, 'agentTypes') },
    ]
  }
  if (provider === 'codex') {
    return [
      { label: 'Turns', value: formatOptionalNumber(report.totals.turns) },
      {
        label: 'Reasoning share',
        value: formatPercent(report.totals.tokens.reasoningOutputTokens, report.totals.tokens.outputTokens),
      },
      {
        label: 'Largest context window',
        value: formatOptionalNumber(maxDefined(report.chats.map((chat) => chat.modelContextWindow))),
      },
      { label: 'Model duration', value: formatDuration(report.totals.modelDurationMs) },
      {
        label: 'Average time to first token',
        value: formatDuration(averageDefined(report.chats.map((chat) => chat.performance?.averageTimeToFirstTokenMs))),
      },
      { label: 'Plan types', value: metadataStrings(report.chats, 'planType') },
      { label: 'Workspaces', value: uniqueWorkspaceCount(report.chats) },
    ]
  }
  const childTotals = report.totalsIncludingChildren
  return [
    { label: 'Subagent runs', value: formatNumber(report.chats.filter((chat) => chat.kind === 'subagent').length) },
    { label: 'Tokens including subagents', value: childTotals ? formatNumber(childTotals.tokens.totalTokens) : 'n/a' },
    {
      label: 'Web fetch requests',
      value: formatNumber(sumNestedNumber(report.chats, 'serverToolUse', 'webFetchRequests')),
    },
    {
      label: 'Web search requests',
      value: formatNumber(sumNestedNumber(report.chats, 'serverToolUse', 'webSearchRequests')),
    },
    { label: 'Service tiers', value: metadataStrings(report.chats, 'serviceTiers') },
    { label: 'Inference regions', value: metadataStrings(report.chats, 'inferenceGeos') },
    { label: 'Speeds', value: metadataStrings(report.chats, 'speeds') },
  ]
}

function aggregateToolNames(chats: ChatMetadata[]): string {
  const tools = new Map<string, number>()
  for (const chat of chats) {
    for (const tool of chat.tools?.byTool ?? []) {
      tools.set(tool.tool, (tools.get(tool.tool) ?? 0) + tool.calls)
    }
  }
  return (
    [...tools]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tool, calls]) => `${tool}: ${formatNumber(calls)}`)
      .join(', ') || 'n/a'
  )
}

function metadataStrings(chats: ChatMetadata[], key: string): string {
  const values = new Set<string>()
  for (const chat of chats) {
    const value = chat.providerMetadata[key]
    if (typeof value === 'string' && value) values.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry) values.add(entry)
      }
    }
  }
  return [...values].sort().join(', ') || 'n/a'
}

function sumNestedNumber(chats: ChatMetadata[], parentKey: string, childKey: string): number {
  let total = 0
  for (const chat of chats) {
    const parent = chat.providerMetadata[parentKey]
    if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) continue
    const value = (parent as Record<string, unknown>)[childKey]
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total
}

function uniqueWorkspaceCount(chats: ChatMetadata[]): string {
  const workspaces = new Set(chats.flatMap((chat) => chat.workspacePaths))
  return formatNumber(workspaces.size)
}
