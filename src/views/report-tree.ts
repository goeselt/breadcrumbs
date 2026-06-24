import * as vscode from 'vscode'
import type { AgentId } from '../agent.js'

export type ReportViewKind = 'overview' | 'chats' | 'chatDetail' | 'sources'

export interface DetectedProviderItem {
  provider: AgentId
  label: string
  description: string
}

type ReportTreeItem =
  | {
      type: 'report'
      kind: ReportViewKind
      label: string
      description: string
      command?: string
      icon: string
      collapsibleState: vscode.TreeItemCollapsibleState
    }
  | {
      type: 'provider'
      destination: 'overview' | 'chats'
      provider: AgentId
      label: string
      description: string
    }
  | {
      type: 'allOverview'
      label: string
      description: string
    }
  | {
      type: 'allChats'
      label: string
      description: string
    }

const OVERVIEW_ITEM: ReportTreeItem = {
  type: 'report',
  kind: 'overview',
  label: 'Overview',
  description: 'Provider usage',
  icon: 'dashboard',
  collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
}

const ROOT_ITEMS: ReportTreeItem[] = [
  OVERVIEW_ITEM,
  {
    type: 'report',
    kind: 'chats',
    label: 'Chats',
    description: 'Metadata inventory',
    icon: 'comment-discussion',
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
  },
  {
    type: 'report',
    kind: 'sources',
    label: 'Sources',
    description: 'Readiness and paths',
    command: 'breadcrumbs.openSources',
    icon: 'database',
    collapsibleState: vscode.TreeItemCollapsibleState.None,
  },
]

export class ReportTreeProvider implements vscode.TreeDataProvider<ReportTreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ReportTreeItem | undefined>()
  readonly onDidChangeTreeData = this.changed.event

  constructor(private readonly loadProviders: () => Promise<DetectedProviderItem[]>) {}

  refresh(): void {
    this.changed.fire(undefined)
  }

  dispose(): void {
    this.changed.dispose()
  }

  getTreeItem(item: ReportTreeItem): vscode.TreeItem {
    if (item.type === 'allOverview') {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None)
      treeItem.description = item.description
      treeItem.iconPath = new vscode.ThemeIcon('graph')
      treeItem.command = {
        command: 'breadcrumbs.openOverview',
        title: 'Open All Providers',
      }
      treeItem.contextValue = 'breadcrumbs.overview.all'
      treeItem.tooltip = `${item.label}: ${item.description}`
      return treeItem
    }

    if (item.type === 'allChats') {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None)
      treeItem.description = item.description
      treeItem.iconPath = new vscode.ThemeIcon('list-flat')
      treeItem.command = {
        command: 'breadcrumbs.openChats',
        title: 'Open All Chats',
      }
      treeItem.contextValue = 'breadcrumbs.chats.all'
      treeItem.tooltip = `${item.label}: ${item.description}`
      return treeItem
    }

    if (item.type === 'provider') {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None)
      treeItem.description = item.description
      treeItem.iconPath = new vscode.ThemeIcon(providerIcon(item.provider))
      treeItem.command = {
        command: item.destination === 'overview' ? 'breadcrumbs.openOverview' : 'breadcrumbs.openChats',
        title: item.destination === 'overview' ? `Open ${item.label} Overview` : `Open ${item.label} Chats`,
        arguments: [item.provider],
      }
      treeItem.contextValue = `breadcrumbs.${item.destination}.${item.provider}`
      treeItem.tooltip = `${item.label}: ${item.description}`
      return treeItem
    }

    const treeItem = new vscode.TreeItem(item.label, item.collapsibleState)
    treeItem.description = item.description
    treeItem.iconPath = new vscode.ThemeIcon(item.icon)
    if (item.command) {
      treeItem.command = {
        command: item.command,
        title: item.label,
      }
    }
    treeItem.contextValue = `breadcrumbs.report.${item.kind}`
    treeItem.tooltip = `${item.label}: ${item.description}`
    return treeItem
  }

  async getChildren(element?: ReportTreeItem): Promise<ReportTreeItem[]> {
    if (!element) return ROOT_ITEMS
    if (element.type !== 'report') return []
    if (element.kind === 'overview') {
      return [
        {
          type: 'allOverview',
          label: 'All Providers',
          description: 'Comparable usage summary',
        },
        ...(await this.loadProviders()).map((provider) => ({
          type: 'provider' as const,
          destination: 'overview' as const,
          ...provider,
        })),
      ]
    }
    if (element.kind === 'chats') {
      return [
        {
          type: 'allChats',
          label: 'All Chats',
          description: 'All indexed providers',
        },
        ...(await this.loadProviders()).map((provider) => ({
          type: 'provider' as const,
          destination: 'chats' as const,
          ...provider,
        })),
      ]
    }
    return []
  }
}

function providerIcon(provider: AgentId): string {
  if (provider === 'copilot') return 'github'
  if (provider === 'codex') return 'terminal'
  return 'sparkle'
}
