import * as vscode from 'vscode'
import type { AgentId } from '../agent.js'
import type { ChatMetadata } from '../chat-metadata.js'
import {
  buildRecentChatGroups,
  compactRecentNumber,
  displayRecentChatTitle,
  formatRecentDate,
  formatRecentTime,
  recentProviderLabel,
  recentWorkspaceLabel,
  truncateRecentText,
} from './recent-chats-model.js'

type RecentChatTreeItem =
  | {
      type: 'group'
      key: string
      label: string
      chats: ChatMetadata[]
    }
  | {
      type: 'chat'
      chat: ChatMetadata
    }

export class RecentChatsTreeProvider implements vscode.TreeDataProvider<RecentChatTreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<RecentChatTreeItem | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private providerFilter: AgentId | undefined

  constructor(private readonly loadChats: () => Promise<ChatMetadata[]>) {}

  refresh(): void {
    this.changed.fire(undefined)
  }

  setProviderFilter(provider: AgentId | undefined): void {
    this.providerFilter = provider
    this.refresh()
  }

  getProviderFilter(): AgentId | undefined {
    return this.providerFilter
  }

  dispose(): void {
    this.changed.dispose()
  }

  getTreeItem(item: RecentChatTreeItem): vscode.TreeItem {
    if (item.type === 'group') {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.Expanded)
      treeItem.description = String(item.chats.length)
      treeItem.contextValue = `breadcrumbs.recent.group.${item.key}`
      return treeItem
    }

    const { chat } = item
    const treeItem = new vscode.TreeItem(
      `${formatRecentTime(chat.startedAt)}  ${truncateRecentText(displayRecentChatTitle(chat), 54)}`,
      vscode.TreeItemCollapsibleState.None,
    )
    treeItem.description = `${recentProviderLabel(chat.provider)} - ${compactRecentNumber(chat.tokens.totalTokens)}`
    treeItem.iconPath = new vscode.ThemeIcon(providerIcon(chat.provider))
    treeItem.command = {
      command: 'breadcrumbs.openChatDetail',
      title: 'Open Chat Detail',
      arguments: [{ provider: chat.provider, chatKey: chat.chatKey }],
    }
    treeItem.contextValue = `breadcrumbs.recent.chat.${chat.provider}`
    treeItem.tooltip = recentChatTooltip(chat)
    return treeItem
  }

  async getChildren(element?: RecentChatTreeItem): Promise<RecentChatTreeItem[]> {
    if (element?.type === 'group') {
      return element.chats.map((chat) => ({ type: 'chat', chat }))
    }
    if (element) return []
    const groups = buildRecentChatGroups(await this.loadChats(), new Date(), this.providerFilter)
    return groups.map((group) => ({ type: 'group', ...group }))
  }
}

function recentChatTooltip(chat: ChatMetadata): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true)
  tooltip.appendMarkdown(`**${escapeMarkdown(displayRecentChatTitle(chat))}**\n\n`)
  tooltip.appendMarkdown(`Provider: ${recentProviderLabel(chat.provider)}  \n`)
  tooltip.appendMarkdown(`Started: ${formatRecentDate(chat.startedAt)}  \n`)
  tooltip.appendMarkdown(`Workspace: ${escapeMarkdown(recentWorkspaceLabel(chat))}  \n`)
  tooltip.appendMarkdown(`Requests: ${chat.requests}  \n`)
  tooltip.appendMarkdown(`Tokens: ${chat.tokens.totalTokens}  \n`)
  tooltip.appendMarkdown(`Quality: ${chat.dataQuality.confidence}  \n`)
  tooltip.appendMarkdown(`Semantics: \`${chat.tokens.totalTokenSemantics}\``)
  return tooltip
}

function providerIcon(provider: AgentId): string {
  if (provider === 'copilot') return 'github'
  if (provider === 'codex') return 'terminal'
  return 'sparkle'
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&')
}
