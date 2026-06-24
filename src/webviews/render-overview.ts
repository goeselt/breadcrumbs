import type { AgentId } from '../agent.js'
import type { ChatMetadataReport } from '../chat-metadata.js'
import type { DiscoveryReport } from '../discovery.js'
import { barFrame, categoryBarChart, doughnutChart, topSlices } from './render-charts.js'
import { renderCopilotSetup } from './render-copilot-setup.js'
import {
  barChart,
  cacheShareChart,
  dailyLabels,
  dailyTotals,
  dayLineChart,
  providerDailyChart,
  reasoningShareChart,
  toolUsageEntries,
} from './render-overview-charts.js'
import {
  chartPanel,
  chatField,
  escapeHtml,
  fact,
  formatDate,
  formatNumber,
  formatPercent,
  metric,
  providerLabel,
  sum,
  timestamp,
} from './render-primitives.js'
import { providerSignals, providerSignalTitle } from './render-provider-signals.js'
import { cacheShare, renderProviderUnavailable, renderTokenComposition, tokensByWorkspace } from './render-shared.js'
import type { ProviderReportResult } from './types.js'

export function renderOverview(
  providers: ProviderReportResult[],
  selectedProvider: AgentId | undefined,
  discovery: DiscoveryReport | undefined,
): string {
  if (!selectedProvider) {
    return renderAllProvidersOverview(providers)
  }
  const selected = providers.find((provider) => provider.provider === selectedProvider)
  if (!selected?.report) {
    return `${renderProviderUnavailable(selected, selectedProvider)}
      ${selectedProvider === 'copilot' ? renderCopilotSetup(discovery) : ''}`
  }

  const { report } = selected
  const dates = report.chats
    .flatMap((chat) => [chat.startedAt, chat.endedAt])
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => timestamp(a) - timestamp(b))
  const { tokens } = report.totals
  const qualityCounts = new Map<string, number>()
  for (const chat of report.chats) {
    qualityCounts.set(chat.dataQuality.confidence, (qualityCounts.get(chat.dataQuality.confidence) ?? 0) + 1)
  }
  const quality =
    [...qualityCounts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([confidence, count]) => `${confidence}: ${formatNumber(count)}`)
      .join(', ') || '(unknown)'
  const dateRange = dates.length > 0 ? `${formatDate(dates[0])} - ${formatDate(dates.at(-1))}` : '(unknown)'
  const modelRows = report.totals.models
    .map(
      (model) => `<tr>
        <td class="provider">${escapeHtml(model.model)}</td>
        <td class="number">${formatNumber(model.requests)}</td>
        <td class="number">${formatPercent(model.requests, report.totals.requests)}</td>
        <td class="number">${formatNumber(model.inputTokens)}</td>
        <td class="number">${formatNumber(model.cachedInputTokens)}</td>
        <td class="number">${formatNumber(model.outputTokens)}</td>
        <td class="number">${formatNumber(model.totalTokens)}</td>
        <td class="number">${formatPercent(model.totalTokens, tokens.totalTokens)}</td>
      </tr>`,
    )
    .join('')

  return `${selected.error ? `<div class="error">Last refresh failed; showing the previous successful index. ${escapeHtml(selected.error)}</div>` : ''}
  ${selectedProvider === 'copilot' ? renderCopilotSetup(discovery) : ''}
  <h2>Usage</h2>
  <div class="summary">
    ${metric('Main chats', formatNumber(report.totals.chats))}
    ${metric('Requests', formatNumber(report.totals.requests))}
    ${metric('Total tokens', formatNumber(tokens.totalTokens))}
    ${metric('Cache share', cacheShare(tokens))}
  </div>
  ${renderProviderCharts(selectedProvider, report)}
  <h2>Token composition</h2>
  ${renderTokenComposition(selectedProvider, tokens)}
  <h2>${escapeHtml(providerSignalTitle(selectedProvider))}</h2>
  <div class="facts">
    ${providerSignals(selectedProvider, report)
      .map((signal) => fact(signal.label, signal.value, signal.code))
      .join('')}
  </div>
  <h2>Models</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Model</th><th class="number">Requests</th><th class="number">Request share</th><th class="number">Input</th><th class="number">Cached</th><th class="number">Output</th><th class="number">Total</th><th class="number">Token share</th></tr></thead>
    <tbody>${modelRows || '<tr><td colspan="8">No model metadata available.</td></tr>'}</tbody>
  </table></div>
  <h2>Provider details</h2>
  <div class="facts">
    ${fact('Status', 'Ready')}
    ${fact('Observed range', dateRange)}
    ${fact('Source', report.source.path)}
    ${fact('Files / records', `${formatNumber(report.source.filesRead)} / ${formatNumber(report.source.recordsRead)}`)}
    ${fact('Source entries / main chats', `${formatNumber(report.chats.length)} / ${formatNumber(report.totals.chats)}`)}
    ${fact('Invalid records', formatNumber(report.source.invalidRecords))}
    ${fact('Data quality', quality)}
    ${fact('Token semantics', tokens.totalTokenSemantics)}
  </div>
  ${renderIndexDiagnostics(report)}`
}

function renderAllProvidersOverview(providers: ProviderReportResult[]): string {
  const available = providers.filter((provider): provider is ProviderReportResult & { report: ChatMetadataReport } =>
    Boolean(provider.report),
  )
  const reports = available.map((provider) => provider.report)
  const dates = reports
    .flatMap((report) => report.chats)
    .flatMap((chat) => [chat.startedAt, chat.endedAt])
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => timestamp(a) - timestamp(b))
  const observedRange = dates.length > 0 ? `${formatDate(dates[0])} - ${formatDate(dates.at(-1))}` : '(unknown)'

  return `<div class="summary">
    ${metric('Available providers', formatNumber(available.length))}
    ${metric('Main chats', formatNumber(sum(reports.map((report) => report.totals.chats))))}
    ${metric('Requests', formatNumber(sum(reports.map((report) => report.totals.requests))))}
    ${metric('Observed range', observedRange)}
  </div>
  ${renderAllProviderCharts(available)}
  <h2>Provider usage</h2>
  <div class="provider-list">${providers.map(renderProviderOverviewEntry).join('')}</div>`
}

function renderAllProviderCharts(providers: Array<ProviderReportResult & { report: ChatMetadataReport }>): string {
  if (providers.length === 0) return ''
  const labels = providers.map((provider) => providerLabel(provider.provider))
  const tokenValues = providers.map((provider) => {
    const totals =
      provider.provider === 'claude'
        ? (provider.report.totalsIncludingChildren?.tokens ?? provider.report.totals.tokens)
        : provider.report.totals.tokens
    return totals.totalTokens
  })
  const requestValues = providers.map((provider) => provider.report.totals.requests)
  const modelTotals = new Map<string, number>()
  for (const provider of providers) {
    for (const model of provider.report.totals.models) {
      modelTotals.set(model.model, (modelTotals.get(model.model) ?? 0) + model.totalTokens)
    }
  }
  const modelSlices = topSlices([...modelTotals])
  const workspaceEntries = tokensByWorkspace(
    providers.flatMap((provider) => provider.report.chats),
    15,
  )

  return `<h2>Usage charts</h2>
  <div class="chart-grid">
    ${chartPanel('Daily tokens by provider', 'all-provider-daily-chart', providerDailyChart(providers))}
  </div>
  <div class="chart-grid">
    ${chartPanel('Provider tokens', 'provider-token-chart', barChart(labels, 'Tokens', tokenValues, 0))}
    ${chartPanel('Provider requests', 'provider-request-chart', barChart(labels, 'Requests', requestValues, 3))}
    ${modelSlices.labels.length > 0 ? chartPanel('Model token mix', 'all-model-chart', doughnutChart(modelSlices)) : ''}
  </div>
  ${
    workspaceEntries.length > 0
      ? `<div class="chart-grid">${chartPanel('Tokens by workspace', 'all-workspace-chart', categoryBarChart(workspaceEntries, 5, 'Tokens'), barFrame(workspaceEntries.length))}</div>`
      : ''
  }`
}

function renderProviderCharts(provider: AgentId, report: ChatMetadataReport): string {
  const tokens =
    provider === 'claude' ? (report.totalsIncludingChildren?.tokens ?? report.totals.tokens) : report.totals.tokens
  if (report.chats.length === 0 || tokens.totalTokens === 0) return ''

  const dayLabels = dailyLabels(report.chats)
  const cacheSubset = tokens.totalTokenSemantics.includes('cached_input_is_a_subset_of_input')
  const modelSlices = topSlices(report.totals.models.map((model): [string, number] => [model.model, model.totalTokens]))
  const requestSlices = topSlices(report.totals.models.map((model): [string, number] => [model.model, model.requests]))
  const workspaceEntries = tokensByWorkspace(report.chats, 15)
  const toolEntries = toolUsageEntries(report.chats)
  const reasoningConfig = reasoningShareChart(report.chats, dayLabels)
  const cacheConfig = cacheShareChart(report.chats, dayLabels, cacheSubset)
  const distributionPanels = [
    chartPanel('Model token mix', 'model-token-chart', doughnutChart(modelSlices)),
    requestSlices.labels.length > 0
      ? chartPanel('Requests by model', 'model-request-chart', doughnutChart(requestSlices))
      : '',
    toolEntries.length > 0
      ? chartPanel('Tool usage', 'overview-tool-chart', categoryBarChart(toolEntries, 6, 'Calls'))
      : '',
  ]
    .filter(Boolean)
    .join('')

  return `<h2>Usage charts</h2>
  <div class="chart-grid">
    ${chartPanel(
      'Daily tokens',
      'daily-tokens-chart',
      dayLineChart(
        dayLabels,
        dailyTotals(report.chats, dayLabels, (chat) => chat.tokens.totalTokens),
        'Total tokens',
        0,
        { compact: true },
      ),
    )}
  </div>
  <div class="chart-grid">
    ${chartPanel(
      'Daily requests',
      'daily-requests-chart',
      dayLineChart(
        dayLabels,
        dailyTotals(report.chats, dayLabels, (chat) => chat.requests),
        'Requests',
        3,
      ),
    )}
  </div>
  ${
    reasoningConfig
      ? `<div class="chart-grid">${chartPanel('Reasoning share over time', 'overview-reasoning-chart', reasoningConfig)}</div>`
      : ''
  }
  ${
    cacheConfig
      ? `<div class="chart-grid">${chartPanel('Cache hit rate over time', 'overview-cache-chart', cacheConfig)}</div>`
      : ''
  }
  <div class="chart-grid">${distributionPanels}</div>
  ${
    workspaceEntries.length > 0
      ? `<div class="chart-grid">${chartPanel('Tokens by workspace', 'overview-workspace-chart', categoryBarChart(workspaceEntries, 5, 'Tokens'), barFrame(workspaceEntries.length))}</div>`
      : ''
  }`
}

function renderProviderOverviewEntry(provider: ProviderReportResult): string {
  if (!provider.report) {
    return `<article class="provider-entry">
      <div class="provider-entry-header">
        <div class="provider-entry-title">${escapeHtml(providerLabel(provider.provider))}</div>
        <div class="provider-entry-status">${provider.loading ? 'Loading' : 'Unavailable'}</div>
      </div>
      ${renderProviderUnavailable(provider, provider.provider)}
    </article>`
  }

  const { report } = provider
  const tokens =
    provider.provider === 'claude'
      ? (report.totalsIncludingChildren?.tokens ?? report.totals.tokens)
      : report.totals.tokens
  const topModel = report.totals.models[0]
  const tokenLabel =
    provider.provider === 'claude' && report.totalsIncludingChildren ? 'Tokens incl. subagents' : 'Provider tokens'

  return `<article class="provider-entry">
    <div class="provider-entry-header">
      <div class="provider-entry-title">${escapeHtml(providerLabel(provider.provider))}</div>
      <div class="provider-entry-status">${escapeHtml(providerQuality(report))}</div>
    </div>
    <div class="chat-entry-meta">${escapeHtml(report.source.path)} &middot; ${escapeHtml(tokens.totalTokenSemantics)}</div>
    ${provider.error ? `<div class="error">Previous index retained after refresh failure: ${escapeHtml(provider.error)}</div>` : ''}
    <div class="chat-fields">
      ${chatField('Main chats', formatNumber(report.totals.chats), true)}
      ${chatField('Requests', formatNumber(report.totals.requests), true)}
      ${chatField(tokenLabel, formatNumber(tokens.totalTokens), true)}
      ${chatField('Cache share', cacheShare(tokens), true)}
      ${chatField('Top model', topModel?.model ?? 'n/a')}
      ${chatField('Model share', topModel ? formatPercent(topModel.totalTokens, report.totals.tokens.totalTokens) : 'n/a', true)}
      ${chatField('Invalid records', formatNumber(report.source.invalidRecords), true)}
    </div>
  </article>`
}

function renderIndexDiagnostics(report: ChatMetadataReport): string {
  const files = report.index?.files ?? []
  if (files.length === 0) return ''
  const stale = files.filter((file) => file.mode === 'stale')
  const lowConfidence = files.filter((file) => file.diagnostics.confidence === 'low')
  const pending = files.filter((file) => file.diagnostics.partialLinePending)
  const warnings = files.flatMap((file) => [
    ...(file.warning ? [`${file.sourcePath}: ${file.warning}`] : []),
    ...file.diagnostics.warnings.map((warning) => `${file.sourcePath}: ${warning}`),
  ])
  const parserVersions = [...new Set(files.map((file) => String(file.parserVersion)))].sort().join(', ')
  const sourceFormats = [...new Set(files.map((file) => file.sourceFormat))].sort().join(', ')
  return `<h2>Index diagnostics</h2>
  <div class="facts">
    ${fact('Indexed files', formatNumber(files.length))}
    ${fact('Stale / low confidence', `${formatNumber(stale.length)} / ${formatNumber(lowConfidence.length)}`)}
    ${fact('Partial lines pending', formatNumber(pending.length))}
    ${fact('Parser version', parserVersions)}
    ${fact('Source format', sourceFormats)}
    ${fact('Warnings', warnings.join(' ') || '(none)')}
  </div>`
}

function providerQuality(report: ChatMetadataReport): string {
  const counts = new Map<string, number>()
  for (const chat of report.chats) {
    counts.set(chat.dataQuality.confidence, (counts.get(chat.dataQuality.confidence) ?? 0) + 1)
  }
  return (
    [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([confidence, count]) => `${confidence}: ${formatNumber(count)}`)
      .join(', ') || 'Quality unknown'
  )
}
