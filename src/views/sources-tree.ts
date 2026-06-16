import * as vscode from 'vscode'
import type { AgentId } from '../agent.js'
import type { DiscoveryReport } from '../discovery.js'
import type { ProviderReportResult } from '../webviews/report-html.js'

interface SourcesTreeData {
  discovery: DiscoveryReport
  reports: ProviderReportResult[]
}

type SourcesTreeItem =
  | { type: 'provider'; provider: AgentId; label: string; description: string }
  | { type: 'fact'; label: string; description: string; icon: string; tooltip?: string }

export class SourcesTreeProvider implements vscode.TreeDataProvider<SourcesTreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SourcesTreeItem | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private data: SourcesTreeData | undefined

  constructor(private readonly load: () => Promise<SourcesTreeData>) {}

  refresh(): void {
    this.data = undefined
    // eslint-disable-next-line unicorn/no-useless-undefined -- vscode.EventEmitter#fire requires an explicit argument
    this.changed.fire(undefined)
  }

  dispose(): void {
    this.changed.dispose()
  }

  getTreeItem(item: SourcesTreeItem): vscode.TreeItem {
    if (item.type === 'provider') {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.Collapsed)
      treeItem.description = item.description
      treeItem.iconPath = new vscode.ThemeIcon(providerIcon(item.provider))
      treeItem.contextValue = `breadcrumbs.sources.${item.provider}`
      return treeItem
    }
    const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None)
    treeItem.description = item.description
    treeItem.iconPath = new vscode.ThemeIcon(item.icon)
    treeItem.tooltip = item.tooltip ?? `${item.label}: ${item.description}`
    return treeItem
  }

  async getChildren(element?: SourcesTreeItem): Promise<SourcesTreeItem[]> {
    this.data ??= await this.load()
    if (!element) {
      return this.data.discovery.agents.map((agent) => ({
        type: 'provider',
        provider: agent.agent.id,
        label: agent.agent.label,
        description: agent.readiness.analysis.status,
      }))
    }
    if (element.type !== 'provider') return []
    const agent = this.data.discovery.agents.find((candidate) => candidate.agent.id === element.provider)
    if (!agent) return []
    const report = this.data.reports.find((candidate) => candidate.provider === element.provider)
    return sourceFacts(agent, report)
  }
}

function sourceFacts(
  agent: DiscoveryReport['agents'][number],
  result: ProviderReportResult | undefined,
): SourcesTreeItem[] {
  const items: SourcesTreeItem[] = [
    fact('Analysis', agent.readiness.analysis.status, statusIcon(agent.readiness.analysis.status)),
    fact('Configuration', agent.readiness.configuration.status, statusIcon(agent.readiness.configuration.status)),
    fact('Source', agent.readiness.source.status, statusIcon(agent.readiness.source.status)),
  ]
  if (result?.loading) {
    items.push(fact('Usage index', 'Loading, please wait...', 'sync~spin'))
  } else if (!result?.report) {
    items.push(fact('Usage index', 'Not loaded yet', 'circle-outline'))
  }
  for (const extension of agent.extensions) {
    items.push(
      fact(
        extension.id,
        extension.installed
          ? `${extension.active ? 'active' : 'inactive'}${extension.version ? ` - ${extension.version}` : ''}`
          : 'missing',
        extension.installed ? 'extensions' : 'circle-slash',
      ),
    )
  }
  for (const source of agent.sources) {
    items.push(
      fact(
        source.label,
        source.probe.exists ? source.probe.kind : 'missing',
        source.probe.exists ? 'database' : 'warning',
        source.probe.path,
      ),
    )
  }
  for (const file of result?.report?.index?.files ?? []) {
    const warning = file.warning ?? file.diagnostics.warnings.join(' ')
    items.push(
      fact(
        file.sourcePath,
        `${file.mode} - parser ${file.parserVersion} - ${file.diagnostics.confidence}`,
        file.mode === 'stale' ? 'warning' : 'file-code',
        warning || `${file.diagnostics.recordsUsed}/${file.diagnostics.recordsRead} records used`,
      ),
    )
  }
  for (const finding of [
    ...agent.readiness.configuration.findings,
    ...agent.readiness.analysis.reasons,
    ...(result?.error && result.error !== 'Usage data has not been loaded yet.' ? [result.error] : []),
  ]) {
    items.push(fact('Finding', finding, 'warning'))
  }
  return items
}

function fact(label: string, description: string, icon: string, tooltip?: string): SourcesTreeItem {
  return { type: 'fact', label, description, icon, tooltip }
}

function statusIcon(status: string): string {
  if (status === 'ready' || status === 'available') return 'pass-filled'
  if (status === 'unavailable' || status === 'unsafe') return 'error'
  return 'warning'
}

function providerIcon(provider: AgentId): string {
  if (provider === 'copilot') return 'github'
  if (provider === 'codex') return 'terminal'
  return 'sparkle'
}
