import type { DiscoveryReport } from '../discovery.js'
import { toHomeRelative } from '../path.js'
import { commandHref, escapeHtml, fact } from './render-primitives.js'

/** Step-by-step Copilot telemetry setup guidance shown in the Copilot overview. */
export function renderCopilotSetup(discovery: DiscoveryReport | undefined): string {
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
        `${source.sourceKind}: ${toHomeRelative(source.probe.path)}${source.analysisSupported ? '' : ' (supplemental)'}`,
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
