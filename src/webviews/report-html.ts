import REPORT_CSS from './report.css?inline'
import { renderChatDetail } from './render-chat-detail.js'
import { renderChats } from './render-chats.js'
import { renderOverview } from './render-overview.js'
import { renderSources } from './render-sources.js'
import { providerChatDetailTitle, providerChatsTitle, providerLabel, escapeHtml } from './render-primitives.js'
import type { ReportViewData } from './types.js'
import type { ReportViewKind } from '../views/report-tree.js'

export type { ProviderReportResult, ReportViewData } from './types.js'

export function renderReportHtml(kind: ReportViewKind, data: ReportViewData, nonce: string): string {
  const title =
    kind === 'overview'
      ? data.selectedProvider
        ? providerLabel(data.selectedProvider)
        : 'All Providers'
      : kind === 'chats'
        ? data.selectedProvider
          ? providerChatsTitle(data.selectedProvider)
          : 'All Chats'
        : kind === 'chatDetail'
          ? data.selectedProvider
            ? providerChatDetailTitle(data.selectedProvider)
            : 'Chat Detail'
          : 'Sources'
  const body =
    kind === 'overview'
      ? renderOverview(data.providers, data.selectedProvider, data.discovery)
      : kind === 'chats'
        ? renderChats(data.providers, data.selectedProvider, data.chatDetailNavigation ?? 'none')
        : kind === 'chatDetail'
          ? renderChatDetail(
              data.chatDetail,
              data.chatDetailNavigation ?? 'none',
              data.chatDetailContentEnabled ?? true,
            )
          : renderSources(data.discovery)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">${REPORT_CSS}</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </main>
</body>
</html>`
}

export function renderLoadingHtml(title: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';"><style nonce="${nonce}">body{padding:24px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}p{color:var(--vscode-descriptionForeground)}</style><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>Breadcrumbs is loading the local usage index. This can take a moment on the first run.</p></body></html>`
}

export function renderErrorHtml(title: string, error: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';"><style nonce="${nonce}">body{padding:24px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}p{color:var(--vscode-errorForeground);white-space:pre-wrap}</style><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(error)}</p></body></html>`
}
