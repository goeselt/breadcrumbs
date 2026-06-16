import { homedir } from 'node:os'
import path from 'node:path'
import * as vscode from 'vscode'
import { AGENTS, type AgentDefinition, type AgentId, matchesAgentExtension } from './agent.js'
import { fields, logChannel } from './log.js'
import { expandHome, probePath, toHomeRelative, type FileProbe } from './path.js'
import { resolveSettingState, type SettingState } from './settings.js'
import { copilotDebugLogRootCandidates, copilotTraceDatabaseCandidates } from './adapters/copilot-traces.js'

export interface ExtensionState {
  id: string
  installed: boolean
  active: boolean
  version?: string
}

export interface SourceCandidate {
  agentId: AgentId
  label: string
  sourceKind: 'trace-database' | 'otel-jsonl' | 'debug-log' | 'session-jsonl' | 'extension-log' | 'unknown'
  probe: FileProbe
  sensitiveContentRisk: 'metadata-only-by-default' | 'may-contain-content' | 'unknown'
  analysisSupported?: boolean
}

export interface AgentDiscovery {
  agent: AgentDefinition
  extensions: ExtensionState[]
  settings: SettingState[]
  sources: SourceCandidate[]
  readiness: ProviderReadiness
}

export interface ProviderReadiness {
  configuration: {
    status: 'ready' | 'missing' | 'unsafe' | 'unknown'
    findings: string[]
  }
  source: {
    status: 'available' | 'empty' | 'missing' | 'unreadable' | 'unsupported'
    paths: string[]
  }
  analysis: {
    status: 'ready' | 'partial' | 'unavailable'
    reasons: string[]
  }
}

export interface DiscoveryReport {
  generatedAt: string
  environment: {
    remoteName?: string
    platform: NodeJS.Platform
    home: string
    workspaceTrusted: boolean
  }
  workspaceFolders: string[]
  agents: AgentDiscovery[]
}

export async function discoverAgentSources(): Promise<DiscoveryReport> {
  const log = logChannel()
  const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
  const agents = await Promise.all(AGENTS.map((agent) => discoverAgent(agent)))
  log.debug(
    `discover ${fields({
      remote: vscode.env.remoteName,
      trusted: vscode.workspace.isTrusted,
      agents: agents.map((agent) => `${agent.agent.id}:${agent.readiness.analysis.status}`).join(','),
    })}`,
  )

  return {
    generatedAt: new Date().toISOString(),
    environment: {
      remoteName: vscode.env.remoteName,
      platform: process.platform,
      home: toHomeRelative(homedir()),
      workspaceTrusted: vscode.workspace.isTrusted,
    },
    workspaceFolders,
    agents,
  }
}

async function discoverAgent(agent: AgentDefinition): Promise<AgentDiscovery> {
  const config = vscode.workspace.getConfiguration()
  const extensions = discoverExtensions(agent)
  const settingIds =
    agent.id === 'copilot' ? [...agent.relevantSettings, 'breadcrumbs.copilotOtelFile'] : agent.relevantSettings
  const settings = settingIds.map((id) => discoverSetting(config, id, vscode.workspace.isTrusted))
  const sources = await discoverSources(agent, settings)
  const readiness = providerReadiness(agent.id, settings, sources)
  logChannel().trace(
    `discover-agent ${fields({
      agent: agent.id,
      configuration: readiness.configuration.status,
      source: readiness.source.status,
      analysis: readiness.analysis.status,
    })}`,
  )

  return { agent, extensions, settings, sources, readiness }
}

function providerReadiness(provider: AgentId, settings: SettingState[], sources: SourceCandidate[]): ProviderReadiness {
  const findings: string[] = []
  let configuration: ProviderReadiness['configuration']['status'] = 'ready'

  if (provider === 'copilot') {
    const enabled = settingValue<boolean>(settings, 'github.copilot.chat.otel.enabled')
    const captureContent = settingValue<boolean>(settings, 'github.copilot.chat.otel.captureContent')
    const exporterType = settingValue<string>(settings, 'github.copilot.chat.otel.exporterType')
    const databaseEnabled = settingValue<boolean>(settings, 'github.copilot.chat.otel.dbSpanExporter.enabled')
    if (captureContent === true) {
      findings.push(
        'Copilot content capture is enabled; trace details can include prompts, code, tool data, and secrets.',
      )
    }
    if (enabled !== true && databaseEnabled !== true) {
      configuration = 'missing'
      findings.push('Neither Copilot OTel nor the local trace database exporter is enabled.')
    } else if (databaseEnabled !== true && exporterType && exporterType !== 'file') {
      configuration = 'missing'
      findings.push(`Copilot exporter type is ${exporterType}; JSONL fallback analysis requires file output.`)
    }
  }

  const available = sources.filter((source) => source.probe.exists && source.analysisSupported !== false)
  const sourceStatus: ProviderReadiness['source']['status'] =
    sources.length === 0 ? 'unsupported' : available.length > 0 ? 'available' : 'missing'
  const reasons: string[] = []
  let analysis: ProviderReadiness['analysis']['status'] = 'ready'
  if (sourceStatus !== 'available') {
    analysis = 'unavailable'
    reasons.push('No supported data source is available on this extension host.')
  } else if (configuration !== 'ready') {
    analysis = 'partial'
    reasons.push('Existing source data is readable, but current configuration will not reliably produce new data.')
  }

  return {
    configuration: { status: configuration, findings },
    source: {
      status: sourceStatus,
      paths: sources.map((source) => toHomeRelative(source.probe.path)),
    },
    analysis: { status: analysis, reasons },
  }
}

function discoverExtensions(agent: AgentDefinition): ExtensionState[] {
  const matched = vscode.extensions.all.filter((extension) => matchesAgentExtension(agent, extension.id))
  if (matched.length > 0) {
    return matched.map((extension) => ({
      id: extension.id,
      installed: true,
      active: extension.isActive,
      version: extension.packageJSON?.version,
    }))
  }

  return agent.extensionIds.map((id) => ({ id, installed: false, active: false }))
}

function discoverSetting(config: vscode.WorkspaceConfiguration, id: string, workspaceTrusted: boolean): SettingState {
  const inspection = config.inspect(id)
  return resolveSettingState(id, config.get(id), inspection, workspaceTrusted)
}

function discoverSources(agent: AgentDefinition, settings: SettingState[]): Promise<SourceCandidate[]> {
  const candidates = sourcePathsFor(agent, settings)
  return Promise.all(
    candidates.map(async (candidate) => {
      const probe = await probePath(candidate.probe.path)
      logChannel().trace(
        `probe-source ${fields({ agent: agent.id, kind: candidate.sourceKind, path: probe.path, exists: probe.exists, probeKind: probe.kind })}`,
      )
      return { ...candidate, probe }
    }),
  )
}

function sourcePathsFor(
  agent: AgentDefinition,
  settings: SettingState[],
): Array<Omit<SourceCandidate, 'probe'> & { probe: Pick<FileProbe, 'path'> }> {
  const home = homedir()
  if (agent.id === 'copilot') {
    const configured = settingValue<string>(settings, 'github.copilot.chat.otel.outfile')
    const configuredOverride = settingValue<string>(settings, 'breadcrumbs.copilotOtelFile')
    const outfile = configuredOverride || configured
    const paths = outfile ? [expandHome(outfile, home)] : []

    return [
      ...paths.map((candidatePath) => ({
        agentId: agent.id,
        label: `Copilot OTel JSONL (${toHomeRelative(candidatePath, home)})`,
        sourceKind: 'otel-jsonl' as const,
        sensitiveContentRisk: 'metadata-only-by-default' as const,
        analysisSupported: true,
        probe: { path: candidatePath },
      })),
      ...copilotTraceDatabaseCandidates(home).map((candidatePath) => ({
        agentId: agent.id,
        label: `Copilot agent traces (${toHomeRelative(candidatePath, home)})`,
        sourceKind: 'trace-database' as const,
        sensitiveContentRisk: 'may-contain-content' as const,
        analysisSupported: true,
        probe: { path: candidatePath },
      })),
      ...copilotDebugLogRootCandidates(home).map((candidatePath) => ({
        agentId: agent.id,
        label: `Copilot workspace debug logs (${toHomeRelative(candidatePath, home)})`,
        sourceKind: 'debug-log' as const,
        sensitiveContentRisk: 'may-contain-content' as const,
        analysisSupported: false,
        probe: { path: candidatePath },
      })),
    ]
  }

  if (agent.id === 'codex') {
    return [
      {
        agentId: agent.id,
        label: 'Codex sessions',
        sourceKind: 'session-jsonl',
        sensitiveContentRisk: 'may-contain-content',
        analysisSupported: true,
        probe: { path: path.join(home, '.codex', 'sessions') },
      },
      {
        agentId: agent.id,
        label: 'Codex extension logs',
        sourceKind: 'extension-log',
        sensitiveContentRisk: 'may-contain-content',
        analysisSupported: false,
        probe: { path: path.join(home, '.vscode-server', 'data', 'logs') },
      },
    ]
  }

  if (agent.id === 'claude') {
    return [
      {
        agentId: agent.id,
        label: 'Claude project sessions',
        sourceKind: 'session-jsonl',
        sensitiveContentRisk: 'may-contain-content',
        analysisSupported: true,
        probe: { path: path.join(home, '.claude', 'projects') },
      },
      {
        agentId: agent.id,
        label: 'Claude extension logs',
        sourceKind: 'extension-log',
        sensitiveContentRisk: 'may-contain-content',
        analysisSupported: false,
        probe: { path: path.join(home, '.vscode-server', 'data', 'logs') },
      },
    ]
  }

  return []
}

function settingValue<T>(settings: SettingState[], id: string): T | undefined {
  const value = settings.find((setting) => setting.id === id)?.value
  return value === undefined || value === null || value === '' ? undefined : (value as T)
}
