import type { AgentId } from '../agent.js'
import type { ChatMetadata, ChatMetadataReport } from '../chat-metadata.js'
import type { DiscoveryReport } from '../discovery.js'
import { toHomeRelative } from '../path.js'
import {
  chatField,
  commandHref,
  escapeHtml,
  fact,
  formatDate,
  formatDuration,
  formatNumber,
  formatOptionalNumber,
  formatPercent,
  averageDefined,
  chartColor as color,
  chartPanel,
  maxDefined,
  metric,
  providerLabel,
  sum,
  timestamp,
} from './render-primitives.js'
import { barFrame, categoryBarChart, doughnutChart, topSlices } from './render-charts.js'
import {
  cacheShare,
  renderProviderUnavailable,
  renderTokenComposition,
  tokensByWorkspace,
  type ProviderSignal,
} from './render-shared.js'
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

function renderCopilotSetup(discovery: DiscoveryReport | undefined): string {
  const agent = discovery?.agents.find((candidate) => candidate.agent.id === 'copilot')
  if (!agent) return ''
  const setting = (id: string) => agent.settings.find((candidate) => candidate.id === id)
  const databaseSetting = setting('github.copilot.chat.otel.dbSpanExporter.enabled')
  const otelSetting = setting('github.copilot.chat.otel.enabled')
  const exporterSetting = setting('github.copilot.chat.otel.exporterType')
  const outfileSetting = setting('github.copilot.chat.otel.outfile')
  const captureSetting = setting('github.copilot.chat.otel.captureContent')
  const databaseEnabled = databaseSetting?.value === true
  const otelEnabled = otelSetting?.value === true
  const exporterType = exporterSetting?.value
  const captureContent = captureSetting?.value === true
  const settingsLocation = discovery?.environment.remoteName
    ? `Remote Settings for the ${discovery.environment.remoteName} extension host`
    : 'User Settings on this VS Code installation'
  const scopeGuidance = discovery?.environment.remoteName
    ? `Open Settings and select the Remote [${discovery.environment.remoteName}] tab. Workspace Settings also work, but only for this workspace.`
    : 'Open User Settings. Workspace Settings also work, but only for this workspace.'
  const preferred = setupEntry({
    label: 'Structured agent traces',
    state: databaseEnabled ? 'active' : 'missing',
    stateLabel: databaseEnabled ? 'Active' : 'Recommended setting missing',
    description: databaseEnabled
      ? 'Breadcrumbs can read the hierarchical Copilot trace database with requests, tools, parent-child links, and token usage.'
      : "Enable Copilot's local trace database. This is Breadcrumbs's preferred source and no output path is required.",
    current: settingDisplayValue(databaseSetting?.value),
    target: 'true',
    settingId: 'github.copilot.chat.otel.dbSpanExporter.enabled',
    json: databaseEnabled ? undefined : settingsJson({ 'github.copilot.chat.otel.dbSpanExporter.enabled': true }),
  })
  const content = setupEntry({
    label: 'Prompt and tool content',
    state: captureContent ? 'active' : 'optional',
    stateLabel: captureContent ? 'Active' : 'Optional',
    description: captureContent
      ? 'Copilot may record prompts, responses, reasoning, tool arguments, tool results, source code, paths, and secrets.'
      : 'Enable only when Chat Detail should include captured prompts, responses, reasoning, and tool data. Token and structural analysis work without it.',
    current: settingDisplayValue(captureSetting?.value),
    target: 'true (optional)',
    settingId: 'github.copilot.chat.otel.captureContent',
    json: captureContent ? undefined : settingsJson({ 'github.copilot.chat.otel.captureContent': true }),
  })
  const fallbackReady =
    otelEnabled &&
    exporterType === 'file' &&
    typeof outfileSetting?.value === 'string' &&
    outfileSetting.value.length > 0
  const fallback = setupEntry({
    label: 'OTel JSONL fallback',
    state: databaseEnabled || fallbackReady ? 'active' : 'optional',
    stateLabel: databaseEnabled ? 'Not required' : fallbackReady ? 'Active' : 'Alternative',
    description: databaseEnabled
      ? 'The trace database is active, so the flatter JSONL exporter is not required.'
      : 'Use this only when the trace database is unavailable. Choose an absolute output path on the same extension host.',
    current: databaseEnabled
      ? 'not required'
      : `enabled=${settingDisplayValue(otelSetting?.value)}, exporterType=${settingDisplayValue(exporterType)}, outfile=${settingDisplayValue(outfileSetting?.value)}`,
    target: databaseEnabled ? 'n/a' : 'enabled=true, exporterType="file", outfile=<absolute path>',
    settingId: 'github.copilot.chat.otel.enabled',
    additionalSettingIds: ['github.copilot.chat.otel.exporterType', 'github.copilot.chat.otel.outfile'],
    json:
      databaseEnabled || fallbackReady
        ? undefined
        : settingsJson({
            'github.copilot.chat.otel.enabled': true,
            'github.copilot.chat.otel.exporterType': 'file',
            'github.copilot.chat.otel.outfile': '<absolute-path>/copilot-otel.jsonl',
          }),
  })
  const sources = agent.sources
    .filter((source) => source.probe.exists)
    .map(
      (source) =>
        `${source.sourceKind}: ${toDisplayPath(source.probe.path)}${source.analysisSupported ? '' : ' (supplemental)'}`,
    )
  return `<h2>Copilot data setup</h2>
  <p class="setup-intro">Configure Copilot where its extension runs: <strong>${escapeHtml(settingsLocation)}</strong>. ${escapeHtml(scopeGuidance)} Use each Open setting action or merge the shown JSON into that scope's <code>settings.json</code>. After changing telemetry settings, reload the VS Code window, use Copilot Chat, and run <strong>Breadcrumbs: Refresh Usage Index</strong>.</p>
  <div class="setup-list">
    ${preferred}
    ${content}
    ${fallback}
  </div>
  <h2>Detected Copilot sources</h2>
  <div class="facts">${fact('Sources', sources.join(', ') || 'No supported Copilot source detected.')}</div>`
}

function setupEntry(input: {
  label: string
  state: 'active' | 'missing' | 'optional'
  stateLabel: string
  description: string
  current: string
  target: string
  settingId: string
  additionalSettingIds?: string[]
  json?: string
}): string {
  if (input.state === 'active') {
    return `<article class="setup-entry">
      <div class="setup-entry-header">
        <div class="setup-entry-title">${escapeHtml(input.label)}</div>
        <div class="setup-entry-state ${input.state}">${escapeHtml(input.stateLabel)}</div>
      </div>
    </article>`
  }
  const settingIds = [input.settingId, ...(input.additionalSettingIds ?? [])]
  return `<article class="setup-entry">
    <div class="setup-entry-header">
      <div class="setup-entry-title">${escapeHtml(input.label)}</div>
      <div class="setup-entry-state ${input.state}">${escapeHtml(input.stateLabel)}</div>
    </div>
    <div class="setup-entry-description">${escapeHtml(input.description)}</div>
    <div class="setup-entry-values">
      ${setupValue('Current value', input.current)}
      ${setupValue('Target value', input.target)}
      ${setupValue('Setting', settingIds.join(', '))}
    </div>
    <div class="setup-actions">${settingIds
      .map(
        (id) =>
          `<a class="setup-action" href="${escapeHtml(commandHref('breadcrumbs.openCopilotSetting', { setting: id }))}">Open ${escapeHtml(shortSettingName(id))}</a>`,
      )
      .join('')}</div>
    ${input.json ? `<pre class="settings-json">${escapeHtml(input.json)}</pre>` : ''}
  </article>`
}

function setupValue(label: string, value: string): string {
  return `<div class="setup-value"><div class="setup-value-label">${escapeHtml(label)}</div><code>${escapeHtml(value)}</code></div>`
}

function settingDisplayValue(value: unknown): string {
  if (value === undefined) return '(not configured)'
  return JSON.stringify(value)
}

function settingsJson(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2)
}

function shortSettingName(settingId: string): string {
  return settingId.replace('github.copilot.chat.otel.', '')
}

function toDisplayPath(value: string): string {
  return toHomeRelative(value)
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
    ${chartPanel('Provider tokens', 'provider-token-chart', barChart(labels, 'Tokens', tokenValues, color(0)))}
    ${chartPanel('Provider requests', 'provider-request-chart', barChart(labels, 'Requests', requestValues, color(3)))}
    ${modelSlices.labels.length > 0 ? chartPanel('Model token mix', 'all-model-chart', doughnutChart(modelSlices)) : ''}
  </div>
  ${
    workspaceEntries.length > 0
      ? `<div class="chart-grid">${chartPanel('Tokens by workspace', 'all-workspace-chart', categoryBarChart(workspaceEntries, 5, 'Tokens'), barFrame(workspaceEntries.length))}</div>`
      : ''
  }`
}

const PROVIDER_COLOR_ORDER: AgentId[] = ['claude', 'codex', 'copilot']

/** Stacked daily token usage with one colored series per provider, sharing one day axis. */
function providerDailyChart(providers: Array<ProviderReportResult & { report: ChatMetadataReport }>): unknown {
  const labels = dailyLabels(providers.flatMap((provider) => provider.report.chats))
  const datasets = providers.map((provider) => {
    const buckets = new Map<string, number>()
    for (const chat of provider.report.chats) {
      const key = dateKey(chat.startedAt ?? chat.endedAt)
      if (!key) continue
      buckets.set(key, (buckets.get(key) ?? 0) + chat.tokens.totalTokens)
    }
    const colorIndex = Math.max(0, PROVIDER_COLOR_ORDER.indexOf(provider.provider))
    return {
      label: providerLabel(provider.provider),
      data: labels.map((label) => buckets.get(label) ?? 0),
      backgroundColor: color(colorIndex, 0.7),
      borderColor: color(colorIndex),
      borderWidth: 1,
      stack: 'tokens',
    }
  })
  return {
    type: 'bar',
    data: { labels, datasets },
    options: {
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, ticks: { format: { notation: 'compact', maximumFractionDigits: 1 } } },
      },
    },
  }
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
    ${chartPanel('Daily tokens', 'daily-tokens-chart', dayLineChart(dayLabels, dailyTotals(report.chats, dayLabels, (chat) => chat.tokens.totalTokens), 'Total tokens', 0, { compact: true }))}
  </div>
  <div class="chart-grid">
    ${chartPanel('Daily requests', 'daily-requests-chart', dayLineChart(dayLabels, dailyTotals(report.chats, dayLabels, (chat) => chat.requests), 'Requests', 3))}
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

function toolUsageEntries(chats: ChatMetadata[]): Array<[string, number]> {
  const byTool = new Map<string, number>()
  for (const chat of chats) {
    for (const tool of chat.tools?.byTool ?? []) {
      byTool.set(tool.tool, (byTool.get(tool.tool) ?? 0) + tool.calls)
    }
  }
  return [...byTool]
    .filter(([, calls]) => calls > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
}

/** Sorted unique day keys (YYYY-MM-DD) across the chats, used as a shared x scale. */
function dailyLabels(chats: ChatMetadata[]): string[] {
  const days = new Set<string>()
  for (const chat of chats) {
    const key = dateKey(chat.startedAt ?? chat.endedAt)
    if (key) days.add(key)
  }
  return [...days].sort((a, b) => a.localeCompare(b))
}

/** Per-day totals for the shared day labels (0 where a day has no data). */
function dailyTotals(chats: ChatMetadata[], labels: string[], pick: (chat: ChatMetadata) => number): number[] {
  const buckets = new Map<string, number>()
  for (const chat of chats) {
    const key = dateKey(chat.startedAt ?? chat.endedAt)
    if (!key) continue
    buckets.set(key, (buckets.get(key) ?? 0) + pick(chat))
  }
  return labels.map((label) => buckets.get(label) ?? 0)
}

/**
 * Single-axis day line chart shared by every time series (tokens, requests, reasoning %, cache %).
 * Using one chart type and one left y-axis (pinned by matchAxisWidth) keeps the day scale identical
 * across the stacked charts -- mixing bar and line types offsets the category axis differently.
 */
function dayLineChart(
  labels: string[],
  data: number[],
  seriesLabel: string,
  colorIndex: number,
  opts: { max?: number; compact?: boolean } = {},
): unknown {
  const ticks = {
    color: color(colorIndex),
    ...(opts.compact ? { format: { notation: 'compact', maximumFractionDigits: 1 } } : {}),
  }
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: seriesLabel,
          data,
          borderColor: color(colorIndex),
          backgroundColor: color(colorIndex, 0.18),
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      matchAxisWidth: 60,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        y: { beginAtZero: true, ticks, ...(opts.max !== undefined ? { max: opts.max } : {}) },
      },
      plugins: { legend: { display: false } },
    },
  }
}

function reasoningShareChart(chats: ChatMetadata[], labels: string[]): unknown | undefined {
  if (sum(chats.map((chat) => chat.tokens.reasoningOutputTokens)) === 0) return undefined
  const buckets = new Map<string, { reasoning: number; output: number }>()
  for (const chat of chats) {
    const key = dateKey(chat.startedAt ?? chat.endedAt)
    if (!key) continue
    const bucket = buckets.get(key) ?? { reasoning: 0, output: 0 }
    bucket.reasoning += chat.tokens.reasoningOutputTokens
    bucket.output += chat.tokens.outputTokens
    buckets.set(key, bucket)
  }
  const data = labels.map((label) => {
    const bucket = buckets.get(label)
    return bucket && bucket.output > 0 ? Math.round((bucket.reasoning / bucket.output) * 1000) / 10 : 0
  })
  return dayLineChart(labels, data, 'Reasoning share %', 4, { max: 100 })
}

function cacheShareChart(chats: ChatMetadata[], labels: string[], subset: boolean): unknown | undefined {
  if (sum(chats.map((chat) => chat.tokens.cachedInputTokens)) === 0) return undefined
  const buckets = new Map<string, { cached: number; input: number; cacheCreation: number }>()
  for (const chat of chats) {
    const key = dateKey(chat.startedAt ?? chat.endedAt)
    if (!key) continue
    const bucket = buckets.get(key) ?? { cached: 0, input: 0, cacheCreation: 0 }
    bucket.cached += chat.tokens.cachedInputTokens
    bucket.input += chat.tokens.inputTokens
    bucket.cacheCreation += chat.tokens.cacheCreationInputTokens
    buckets.set(key, bucket)
  }
  const data = labels.map((label) => {
    const bucket = buckets.get(label)
    if (!bucket) return 0
    const denominator = subset ? bucket.input : bucket.input + bucket.cached + bucket.cacheCreation
    return denominator > 0 ? Math.round((bucket.cached / denominator) * 1000) / 10 : 0
  })
  return dayLineChart(labels, data, 'Cache hit rate %', 5, { max: 100 })
}

function barChart(labels: string[], label: string, values: number[], chartColor: string): unknown {
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label,
          data: values,
          backgroundColor: chartColor.replace('0.88', '0.68'),
          borderColor: chartColor,
          borderWidth: 1,
        },
      ],
    },
    options: {
      scales: {
        y: { beginAtZero: true },
      },
    },
  }
}


function dateKey(value: string | undefined): string | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return undefined
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0'),
  ].join('-')
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

function providerSignalTitle(provider: AgentId): string {
  if (provider === 'copilot') return 'Copilot activity'
  if (provider === 'codex') return 'Codex execution'
  return 'Claude activity'
}

function providerSignals(provider: AgentId, report: ChatMetadataReport): ProviderSignal[] {
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
