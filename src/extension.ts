import * as vscode from 'vscode'
import { AGENTS, type AgentId } from './agent.js'
import { readIndexedChatDetail } from './adapters/chat-detail.js'
import type { ChatDetailReport } from './chat-detail.js'
import { discoverAgentSources, type DiscoveryReport } from './discovery.js'
import { readIndexedChatMetadata } from './index/chat-metadata-index.js'
import { createMetadataIndexWatchers } from './index/watch.js'
import { disposeLogChannel, fields, logChannel } from './log.js'
import { renderReport } from './report.js'
import { detectedProviderItems } from './views/detected-providers.js'
import { RecentChatsTreeProvider } from './views/recent-chats.js'
import { recentChatQuickPickLabel } from './views/recent-chats-model.js'
import { ReportTreeProvider, type ReportViewKind } from './views/report-tree.js'
import { SourcesTreeProvider } from './views/sources-tree.js'
import type { ProviderReportResult, ReportViewData } from './webviews/report-html.js'
import { ReportPanelManager } from './webviews/report-panels.js'

let output: vscode.OutputChannel | undefined
const indexedProviders = new Set<AgentId>()
const refreshTimers = new Map<AgentId, NodeJS.Timeout>()
const providerReports = new Map<AgentId, ProviderReportResult>()
const providerLoads = new Map<AgentId, Promise<ProviderReportResult>>()
// Session-scoped cache of rendered chat-detail snapshots. Not persisted: detail views can contain
// captured prompts and secrets, which must not be written to disk. Cleared whenever an index refresh
// could have changed the underlying chats.
const chatDetailCache = new Map<string, ChatDetailReport>()
let discoveryReport: DiscoveryReport | undefined
let reportPanels: ReportPanelManager | undefined
let reportTree: ReportTreeProvider | undefined
let recentChatsTree: RecentChatsTreeProvider | undefined
let recentChatsView: vscode.TreeView<unknown> | undefined
let sourcesTree: SourcesTreeProvider | undefined

interface ChatSelection {
  provider?: AgentId
  chatKey?: string
}

const PROVIDERS: AgentId[] = ['copilot', 'codex', 'claude']
const COPILOT_SETTINGS = new Set(AGENTS.find((agent) => agent.id === 'copilot')?.relevantSettings ?? [])
let metadataWatcher: vscode.Disposable | undefined

export function activate(ctx: vscode.ExtensionContext) {
  const log = logChannel()
  log.info(`activate ${fields({ storageRoot: ctx.globalStorageUri.fsPath })}`)
  reportPanels = new ReportPanelManager((kind, selectedProvider, selectedChatKey) =>
    loadReportView(ctx, kind, selectedProvider, selectedChatKey),
  )
  reportTree = new ReportTreeProvider(loadDetectedProviders)
  recentChatsTree = new RecentChatsTreeProvider(() => loadRecentChats(ctx))
  sourcesTree = new SourcesTreeProvider(() => loadSourcesTreeData())
  recentChatsView = vscode.window.createTreeView('breadcrumbs.recentChats', {
    treeDataProvider: recentChatsTree,
  }) as vscode.TreeView<unknown>
  ctx.subscriptions.push(
    reportPanels,
    reportTree,
    recentChatsTree,
    recentChatsView,
    sourcesTree,
    vscode.window.registerTreeDataProvider('breadcrumbs.reports', reportTree),
    vscode.window.registerTreeDataProvider('breadcrumbs.sources', sourcesTree),
  )
  void vscode.commands.executeCommand('setContext', 'breadcrumbs.hasChats', false)
  const onProviderFileChange = (provider: AgentId) => {
    if (!indexedProviders.has(provider)) {
      log.trace(`watch-file-change ${fields({ provider, action: 'ignored', reason: 'not-yet-indexed' })}`)
      return
    }
    log.debug(`watch-file-change ${fields({ provider, action: 'scheduled-refresh', delayMs: 500 })}`)
    const previous = refreshTimers.get(provider)
    if (previous) clearTimeout(previous)
    refreshTimers.set(
      provider,
      setTimeout(() => {
        refreshTimers.delete(provider)
        void refreshProviderResult(ctx, provider, undefined, false)
          .then(async () => {
            await refreshNativeViews()
          })
          .catch(() => {})
      }, 500),
    )
  }
  metadataWatcher = createMetadataIndexWatchers(configuredCopilotSource(), onProviderFileChange)
  log.debug(`watch-setup ${fields({ copilotSource: configuredCopilotSource() })}`)
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('breadcrumbs.copilotOtelFile') ||
        event.affectsConfiguration('github.copilot.chat.otel.outfile')
      ) {
        log.info(`watch-recreate ${fields({ reason: 'config-changed', copilotSource: configuredCopilotSource() })}`)
        metadataWatcher?.dispose()
        metadataWatcher = createMetadataIndexWatchers(configuredCopilotSource(), onProviderFileChange)
      }
    }),
  )
  ctx.subscriptions.push(
    vscode.commands.registerCommand('breadcrumbs.inspectSources', async () => {
      log.debug(`command ${fields({ command: 'breadcrumbs.inspectSources' })}`)
      if (!enabled()) {
        log.trace(`command ${fields({ command: 'breadcrumbs.inspectSources', action: 'skipped', reason: 'disabled' })}`)
        return
      }
      const report = await refreshDiscovery()
      await refreshNativeViews()
      const channel = getOutput()
      channel.clear()
      channel.appendLine(renderReport(report))
      channel.show(true)
    }),
    vscode.commands.registerCommand('breadcrumbs.openOverview', (provider?: AgentId) => openProviderOverview(provider)),
    vscode.commands.registerCommand('breadcrumbs.openChats', (provider?: AgentId) =>
      reportPanels?.open('chats', provider),
    ),
    vscode.commands.registerCommand(
      'breadcrumbs.openChatDetail',
      (selection?: { provider?: AgentId; chatKey?: string }) => openChatDetail(selection),
    ),
    vscode.commands.registerCommand('breadcrumbs.openSources', () => reportPanels?.open('sources')),
    vscode.commands.registerCommand('breadcrumbs.openCopilotSetting', (selection?: { setting?: string }) =>
      openCopilotSetting(selection),
    ),
    vscode.commands.registerCommand('breadcrumbs.openChatQuickPick', () => openChatQuickPick(ctx)),
    vscode.commands.registerCommand('breadcrumbs.filterRecentChats', () => filterRecentChats()),
    vscode.commands.registerCommand('breadcrumbs.refreshChatSnapshot', (selection?: ChatSelection) =>
      refreshChatSnapshot(ctx, selection),
    ),
    vscode.commands.registerCommand('breadcrumbs.refreshIndex', async () => {
      log.debug(`command ${fields({ command: 'breadcrumbs.refreshIndex' })}`)
      if (!enabled()) {
        log.trace(`command ${fields({ command: 'breadcrumbs.refreshIndex', action: 'skipped', reason: 'disabled' })}`)
        return
      }
      const reports = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Breadcrumbs: Refreshing usage index',
          cancellable: true,
        },
        async (_progress, token) => {
          const controller = new AbortController()
          const cancellation = token.onCancellationRequested(() => controller.abort(new Error('Refresh cancelled.')))
          try {
            const results = await refreshAllProviders(ctx, controller.signal)
            await refreshDiscovery()
            await refreshNativeViews()
            return results
          } finally {
            cancellation.dispose()
          }
        },
      )
      const channel = getOutput()
      channel.clear()
      channel.appendLine(JSON.stringify({ schemaVersion: 1, reportType: 'usage-index', reports }, null, 2))
      channel.show(true)
      await reportPanels?.refreshOpen()
    }),
  )
}

async function openCopilotSetting(selection?: { setting?: string }): Promise<void> {
  if (!selection?.setting || !COPILOT_SETTINGS.has(selection.setting)) return
  logChannel().debug(`command ${fields({ command: 'breadcrumbs.openCopilotSetting', setting: selection.setting })}`)
  await vscode.commands.executeCommand('workbench.action.openSettings', `@id:${selection.setting}`)
}

export function deactivate() {
  for (const timer of refreshTimers.values()) clearTimeout(timer)
  refreshTimers.clear()
  indexedProviders.clear()
  providerReports.clear()
  providerLoads.clear()
  chatDetailCache.clear()
  discoveryReport = undefined
  metadataWatcher?.dispose()
  metadataWatcher = undefined
  reportPanels = undefined
  reportTree = undefined
  recentChatsTree = undefined
  recentChatsView = undefined
  sourcesTree = undefined
  output?.dispose()
  output = undefined
  disposeLogChannel()
}

async function refreshProvider(
  ctx: vscode.ExtensionContext,
  provider: AgentId,
  signal: AbortSignal | undefined,
  markInitialized: boolean,
) {
  const log = logChannel()
  const source = provider === 'copilot' ? configuredCopilotSource() : undefined
  log.debug(`refresh-provider ${fields({ provider, source, action: 'start' })}`)
  try {
    const report = await readIndexedChatMetadata(provider, {
      storageRoot: ctx.globalStorageUri.fsPath,
      source,
      signal,
    })
    if (markInitialized) indexedProviders.add(provider)
    providerReports.set(provider, { provider, report })
    for (const file of report.index?.files ?? []) {
      log.debug(
        `refresh-provider-file ${fields({
          provider,
          sourceId: file.sourceId,
          mode: file.mode,
          appendedRecords: file.appendedRecords,
          warning: file.warning,
        })}`,
      )
    }
    log.info(`refresh-provider ${fields({ provider, action: 'done', chats: report.chats.length })}`)
    if (!markInitialized) {
      getOutput().appendLine(`Indexed ${provider}: ${report.chats.length} entries at ${report.generatedAt}`)
    }
    return report
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`refresh-provider ${fields({ provider, action: 'failed', error: message })}`)
    if (!markInitialized) {
      getOutput().appendLine(`Index refresh failed for ${provider}: ${message}`)
    }
    throw error
  }
}

function refreshAllProviders(ctx: vscode.ExtensionContext, signal?: AbortSignal): Promise<ProviderReportResult[]> {
  return Promise.all(PROVIDERS.map((provider) => refreshProviderResult(ctx, provider, signal, true)))
}

function ensureProviderLoaded(ctx: vscode.ExtensionContext, provider: AgentId): Promise<ProviderReportResult> {
  const current = providerReports.get(provider)
  if (current?.report) return Promise.resolve(current)
  return refreshProviderResult(ctx, provider, undefined, true)
}

function refreshProviderResult(
  ctx: vscode.ExtensionContext,
  provider: AgentId,
  signal: AbortSignal | undefined,
  markInitialized: boolean,
): Promise<ProviderReportResult> {
  const pending = providerLoads.get(provider)
  if (pending) {
    logChannel().trace(`refresh-provider ${fields({ provider, action: 'reused-in-flight' })}`)
    return pending
  }

  const load = (async () => {
    const previous = providerReports.get(provider)?.report
    chatDetailCache.clear()
    providerReports.set(provider, { provider, report: previous, loading: true })
    try {
      const report = await refreshProvider(ctx, provider, signal, markInitialized)
      return { provider, report }
    } catch (error) {
      if (signal?.aborted) {
        if (previous) providerReports.set(provider, { provider, report: previous })
        else providerReports.delete(provider)
        throw error
      }
      const failed = {
        provider,
        report: previous,
        error: error instanceof Error ? error.message : String(error),
      }
      providerReports.set(provider, failed)
      return failed
    } finally {
      providerLoads.delete(provider)
    }
  })()
  providerLoads.set(provider, load)
  return load
}

async function loadReportView(
  ctx: vscode.ExtensionContext,
  kind: ReportViewKind,
  selectedProvider?: AgentId,
  selectedChatKey?: string,
): Promise<ReportViewData> {
  if (kind === 'sources') {
    return {
      discovery: discoveryReport ?? (await refreshDiscovery()),
      providers: orderedProviderReports(),
    }
  }
  if (selectedProvider) {
    await ensureProviderLoaded(ctx, selectedProvider)
  } else if (kind !== 'chatDetail') {
    await Promise.all(PROVIDERS.map((provider) => ensureProviderLoaded(ctx, provider)))
    await refreshNativeViews()
  }
  if (kind === 'chatDetail') {
    const metadata = findIndexedChat(selectedProvider, selectedChatKey)
    if (!metadata) {
      throw new Error('The selected chat is no longer present in the usage index.')
    }
    const cacheKey = `${metadata.provider}:${metadata.chatKey}`
    let chatDetail = chatDetailCache.get(cacheKey)
    if (!chatDetail) {
      chatDetail = await readIndexedChatDetail(metadata, {
        contentMode: vscode.workspace.isTrusted ? 'all' : 'none',
        maxContentChars: 2_000,
        maxEvents: 300,
      })
      chatDetailCache.set(cacheKey, chatDetail)
    }
    return {
      discovery: discoveryReport,
      providers: orderedProviderReports(),
      selectedProvider: metadata.provider,
      selectedChatKey: metadata.chatKey,
      chatDetail,
      chatDetailNavigation: 'command',
      chatDetailContentEnabled: vscode.workspace.isTrusted,
    }
  }
  return {
    discovery: kind === 'overview' ? (discoveryReport ?? (await refreshDiscovery())) : discoveryReport,
    providers: orderedProviderReports(),
    selectedProvider,
    chatDetailNavigation: kind === 'chats' ? 'command' : 'none',
  }
}

async function openChatDetail(selection?: { provider?: AgentId; chatKey?: string }): Promise<void> {
  if (!selection || !isAgentId(selection.provider) || typeof selection.chatKey !== 'string') return
  const log = logChannel()
  log.debug(
    `command ${fields({ command: 'breadcrumbs.openChatDetail', provider: selection.provider, chatKey: selection.chatKey })}`,
  )
  const metadata = findIndexedChat(selection.provider, selection.chatKey)
  if (!metadata) {
    log.warn(
      `command ${fields({ command: 'breadcrumbs.openChatDetail', action: 'not-found', provider: selection.provider, chatKey: selection.chatKey })}`,
    )
    await vscode.window.showWarningMessage('Breadcrumbs could not find that chat in the current index.')
    return
  }
  await reportPanels?.open('chatDetail', metadata.provider, metadata.chatKey)
}

async function loadDetectedProviders() {
  const discovery = discoveryReport ?? (await refreshDiscovery())
  return detectedProviderItems(discovery, providerReports)
}

async function openProviderOverview(provider?: AgentId): Promise<void> {
  logChannel().debug(`command ${fields({ command: 'breadcrumbs.openOverview', provider })}`)
  await reportPanels?.open('overview', provider)
}

async function loadRecentChats(ctx: vscode.ExtensionContext) {
  await Promise.all(PROVIDERS.map((provider) => ensureProviderLoaded(ctx, provider)))
  const chats = orderedProviderReports()
    .flatMap((result) => result.report?.chats ?? [])
    .filter((chat) => chat.kind === 'main' && chat.requests > 0)
  await vscode.commands.executeCommand('setContext', 'breadcrumbs.hasChats', chats.length > 0)
  return chats
}

async function loadSourcesTreeData() {
  return {
    discovery: discoveryReport ?? (await refreshDiscovery()),
    reports: orderedProviderReports(),
  }
}

async function openChatQuickPick(ctx: vscode.ExtensionContext): Promise<void> {
  logChannel().debug(`command ${fields({ command: 'breadcrumbs.openChatQuickPick' })}`)
  const chats = await loadRecentChats(ctx)
  const items = chats.map((chat) => ({ ...recentChatQuickPickLabel(chat), chat }))
  const selected = await vscode.window.showQuickPick(items, {
    title: 'Breadcrumbs: Open Chat',
    placeHolder: 'Search by title, provider, workspace, model, or date',
    matchOnDescription: true,
    matchOnDetail: true,
  })
  if (!selected) return
  await openChatDetail({
    provider: selected.chat.provider,
    chatKey: selected.chat.chatKey,
  })
}

async function filterRecentChats(): Promise<void> {
  logChannel().debug(`command ${fields({ command: 'breadcrumbs.filterRecentChats' })}`)
  const choices: Array<vscode.QuickPickItem & { provider?: AgentId }> = [
    { label: 'All Providers' },
    { label: 'GitHub Copilot Chat', provider: 'copilot' },
    { label: 'Codex', provider: 'codex' },
    { label: 'Claude Code', provider: 'claude' },
  ]
  const selected = await vscode.window.showQuickPick(choices, {
    title: 'Breadcrumbs: Filter Recent Chats',
    placeHolder: 'Choose a provider',
  })
  if (!selected) return
  recentChatsTree?.setProviderFilter(selected.provider)
  if (recentChatsView) {
    recentChatsView.description = selected.provider ? selected.label : undefined
  }
}

async function refreshNativeViews(): Promise<void> {
  reportTree?.refresh()
  recentChatsTree?.refresh()
  sourcesTree?.refresh()
  const hasChats = orderedProviderReports().some((result) =>
    result.report?.chats.some((chat) => chat.kind === 'main' && chat.requests > 0),
  )
  await vscode.commands.executeCommand('setContext', 'breadcrumbs.hasChats', hasChats)
}

async function refreshChatSnapshot(ctx: vscode.ExtensionContext, selection?: ChatSelection): Promise<void> {
  if (!selection || !isAgentId(selection.provider) || typeof selection.chatKey !== 'string') return
  const provider = selection.provider
  logChannel().debug(
    `command ${fields({ command: 'breadcrumbs.refreshChatSnapshot', provider, chatKey: selection.chatKey })}`,
  )
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Breadcrumbs: Refreshing ${providerLabel(provider)} chat snapshot`,
      cancellable: false,
    },
    async () => {
      await refreshProviderResult(ctx, provider, undefined, true)
      await refreshNativeViews()
      await reportPanels?.refresh('chatDetail')
    },
  )
}

async function refreshDiscovery(): Promise<DiscoveryReport> {
  discoveryReport = await discoverAgentSources()
  return discoveryReport
}

function orderedProviderReports(): ProviderReportResult[] {
  return PROVIDERS.map(
    (provider) =>
      providerReports.get(provider) ??
      (providerLoads.has(provider)
        ? { provider, loading: true }
        : { provider, error: 'Usage data has not been loaded yet.' }),
  )
}

function providerLabel(provider: AgentId): string {
  if (provider === 'copilot') return 'GitHub Copilot Chat'
  if (provider === 'codex') return 'Codex'
  return 'Claude Code'
}

function findIndexedChat(provider: AgentId | undefined, chatKey: string | undefined) {
  if (!provider || !chatKey) return
  return providerReports.get(provider)?.report?.chats.find((chat) => chat.chatKey === chatKey)
}

function isAgentId(value: unknown): value is AgentId {
  return value === 'copilot' || value === 'codex' || value === 'claude'
}

function enabled(): boolean {
  return vscode.workspace.getConfiguration('breadcrumbs').get<boolean>('enabled', true)
}

function configuredCopilotSource(): string | undefined {
  const config = vscode.workspace.getConfiguration()
  const configuredFile = config.get<string>('breadcrumbs.copilotOtelFile')
  if (configuredFile) {
    logChannel().trace(
      `resolve-copilot-source ${fields({ source: configuredFile, via: 'breadcrumbs.copilotOtelFile' })}`,
    )
    return configuredFile
  }
  const resolved = vscode.workspace.isTrusted
    ? config.get<string>('github.copilot.chat.otel.outfile') || undefined
    : config.inspect<string>('github.copilot.chat.otel.outfile')?.globalValue || undefined
  logChannel().trace(
    `resolve-copilot-source ${fields({ source: resolved, via: 'github.copilot.chat.otel.outfile', trusted: vscode.workspace.isTrusted })}`,
  )
  return resolved
}

function getOutput(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel('Breadcrumbs')
  return output
}
