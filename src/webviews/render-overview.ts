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
  maxDefined,
  metric,
  providerLabel,
  sum,
  timestamp,
} from './render-primitives.js'
import { cacheShare, providerTokenMetrics, renderProviderUnavailable, type ProviderSignal } from './render-shared.js'
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
  ${selectedProvider === 'copilot' ? renderCopilotSetup(discovery) : ''}
  ${renderIndexDiagnostics(report)}
  <h2>Usage</h2>
  <div class="summary">
    ${metric('Main chats', formatNumber(report.totals.chats))}
    ${metric('Requests', formatNumber(report.totals.requests))}
    ${metric('Total tokens', formatNumber(tokens.totalTokens))}
    ${metric('Cache share', cacheShare(tokens))}
  </div>
  <h2>Token composition</h2>
  <div class="summary">
    ${providerTokenMetrics(selectedProvider, tokens)}
  </div>
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
  </table></div>`
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
  <h2>Provider usage</h2>
  <div class="provider-list">${providers.map(renderProviderOverviewEntry).join('')}</div>`
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
