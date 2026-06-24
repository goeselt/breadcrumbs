import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import type { AgentId } from '../agent.js'
import type { ContentMode } from '../chat-detail.js'
import type { ReportViewKind } from '../views/report-tree.js'
import { renderErrorHtml, renderLoadingHtml, renderReportHtml, type ReportViewData } from './report-html.js'

interface ReportPanelLoader {
  (
    kind: ReportViewKind,
    selectedProvider?: AgentId,
    selectedChatKey?: string,
    selectedContentMode?: ContentMode,
  ): Promise<ReportViewData>
}

const TITLES: Record<ReportViewKind, string> = {
  overview: 'Breadcrumbs Overview',
  chats: 'Breadcrumbs Chats',
  chatDetail: 'Breadcrumbs Chat Detail',
  sources: 'Breadcrumbs Sources',
}

export class ReportPanelManager implements vscode.Disposable {
  private readonly panels = new Map<ReportViewKind, vscode.WebviewPanel>()
  private readonly disposables: vscode.Disposable[] = []
  private overviewProvider: AgentId | undefined
  private chatsProvider: AgentId | undefined
  private detailProvider: AgentId | undefined
  private selectedChatKey: string | undefined
  private detailContentMode: ContentMode = 'all'

  constructor(private readonly load: ReportPanelLoader) {}

  async open(
    kind: ReportViewKind,
    selectedProvider?: AgentId,
    selectedChatKey?: string,
    selectedContentMode?: ContentMode,
  ): Promise<void> {
    if (kind === 'overview') this.overviewProvider = selectedProvider
    if (kind === 'chats') this.chatsProvider = selectedProvider
    if (kind === 'chatDetail') {
      this.detailProvider = selectedProvider
      this.selectedChatKey = selectedChatKey
      this.detailContentMode = selectedContentMode ?? 'all'
    }
    const existing = this.panels.get(kind)
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active)
      await this.render(kind, existing)
      return
    }

    const panel = vscode.window.createWebviewPanel(
      `breadcrumbs.${kind}`,
      panelTitle(kind, this.providerFor(kind)),
      vscode.ViewColumn.Active,
      {
        enableScripts: kind === 'overview' || kind === 'chatDetail',
        enableCommandUris: kind === 'overview' || kind === 'chats' || kind === 'chatDetail',
        retainContextWhenHidden: true,
      },
    )
    this.panels.set(kind, panel)
    panel.onDidDispose(() => this.panels.delete(kind), undefined, this.disposables)
    await this.render(kind, panel)
  }

  async refreshOpen(): Promise<void> {
    await Promise.all([...this.panels].map(([kind, panel]) => this.render(kind, panel)))
  }

  async refresh(kind: ReportViewKind): Promise<void> {
    const panel = this.panels.get(kind)
    if (panel) await this.render(kind, panel)
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose()
    this.panels.clear()
    for (const disposable of this.disposables) disposable.dispose()
    this.disposables.length = 0
  }

  private async render(kind: ReportViewKind, panel: vscode.WebviewPanel): Promise<void> {
    const nonce = randomBytes(16).toString('base64')
    const provider = this.providerFor(kind)
    const title = panelTitle(kind, provider)
    panel.title = title
    panel.webview.html = renderLoadingHtml(title, nonce)
    try {
      const data = await this.load(
        kind,
        provider,
        kind === 'chatDetail' ? this.selectedChatKey : undefined,
        kind === 'chatDetail' ? this.detailContentMode : undefined,
      )
      if (this.panels.get(kind) !== panel) return
      panel.webview.html = renderReportHtml(kind, data, nonce)
    } catch (error) {
      if (this.panels.get(kind) !== panel) return
      panel.webview.html = renderErrorHtml(title, error instanceof Error ? error.message : String(error), nonce)
    }
  }

  private providerFor(kind: ReportViewKind): AgentId | undefined {
    if (kind === 'overview') return this.overviewProvider
    if (kind === 'chats') return this.chatsProvider
    if (kind === 'chatDetail') return this.detailProvider
    return undefined
  }
}

function panelTitle(kind: ReportViewKind, provider: AgentId | undefined): string {
  if (!provider || kind === 'sources') return TITLES[kind]
  const providerName = provider === 'copilot' ? 'GitHub Copilot' : provider === 'codex' ? 'Codex' : 'Claude Code'
  if (kind === 'chats') return `Breadcrumbs: ${providerName} Chats`
  if (kind === 'chatDetail') return `Breadcrumbs: ${providerName} Chat`
  return `Breadcrumbs: ${providerName}`
}
