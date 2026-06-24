import type { ChatDetailReport } from '../chat-detail.js'
import type { ChatMetadata } from '../chat-metadata.js'
import {
  renderModelComposition,
  renderObservedActivity,
  renderProviderTimeline,
  renderToolUsage,
} from './render-chat-detail-charts.js'
import {
  chatField,
  commandHref,
  displayChatTitle,
  escapeHtml,
  fact,
  formatDate,
  formatDuration,
  formatNumber,
  formatOptionalNumber,
  formatPercent,
  formatTimestamp,
  metric,
  providerLabel,
  shortChatId,
  truncateText,
  workspaceLabel,
} from './render-primitives.js'
import { renderTokenComposition } from './render-shared.js'
import { renderTimelineChains } from './render-timeline.js'
import type { ReportViewData } from './types.js'

export function renderChatDetail(
  detail: ChatDetailReport | undefined,
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
  contentEnabled: boolean,
): string {
  if (!detail) return '<div class="empty">No chat is selected.</div>'
  if (!detail.found || !detail.metadata) {
    return `<div class="error">${escapeHtml(detail.note ?? 'The selected chat could not be read.')}</div>`
  }
  const chat = detail.metadata
  const contextEntries = detail.context.map(renderContextEntry).join('')
  const timeline = renderTimelineChains(detail)
  const modelEntries = chat.models.map((model) => renderModelDetail(model, chat.tokens.totalTokens)).join('')
  const notes = chatNotes(detail)

  return `<h2 title="${escapeHtml(truncateText(displayChatTitle(chat), 240))}">${escapeHtml(truncateText(displayChatTitle(chat), 96))}</h2>
  <p>${escapeHtml(formatDate(chat.startedAt))} &middot; ${escapeHtml(workspaceLabel(chat))} &middot; <code>${escapeHtml(shortChatId(chat.providerChatId))}</code></p>
  ${renderSnapshotNotice(detail, navigation)}
  ${renderChatDetailControls(detail, navigation, contentEnabled)}
  <div class="summary">
    ${metric('Total tokens', formatNumber(chat.tokens.totalTokens))}
    ${metric('Requests', formatNumber(chat.requests))}
    ${metric('Turns', formatOptionalNumber(chat.turns))}
    ${metric('Tool calls', formatNumber(chat.tools?.calls ?? 0))}
    ${metric('Timeline events', formatNumber(detail.summary?.timelineEvents ?? detail.timeline.length))}
  </div>
  <nav class="section-nav" aria-label="Chat detail sections">
    <a href="#summary">Summary</a>
    <a href="#timeline">Timeline</a>
    <a href="#context">Context</a>
    <a href="#identity">Identity</a>
  </nav>
  <section id="summary" class="detail-section">
    <h2>Token composition</h2>
    ${renderTokenComposition(chat.provider, chat.tokens)}
    <h2>Models</h2>
    ${renderModelComposition(chat)}
    ${modelEntries ? `<div class="detail-list">${modelEntries}</div>` : '<div class="empty">No model metadata is available.</div>'}
    ${renderProviderTimeline(detail, chat)}
    <h2>Activity</h2>
    ${renderToolUsage(chat.tools)}
    ${renderObservedActivity(detail)}
    ${
      notes.length > 0
        ? `<h2>Notes</h2>
    <ul class="notes-list">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
        : ''
    }
  </section>
  <section id="timeline" class="detail-section">
    <h2>Timeline</h2>
    <p>${formatNumber(detail.summary?.timelineEvents ?? detail.timeline.length)} structural events observed; ${formatNumber(detail.summary?.omittedTimelineEvents ?? 0)} omitted by the display limit. ${escapeHtml(timelineContentDescription(detail))}</p>
    ${timeline || '<div class="empty">No timeline events were observed.</div>'}
  </section>
  <section id="context" class="detail-section">
    <h2>Context structure</h2>
    <p>${escapeHtml(contextContentDescription(detail))}</p>
    ${contextEntries ? `<div class="detail-list">${contextEntries}</div>` : '<div class="empty">No context metadata was observed.</div>'}
  </section>
  <section id="identity" class="detail-section">
    <h2>Identity and source</h2>
    <div class="facts">
      ${fact('Provider', providerLabel(chat.provider))}
      ${fact('Kind', chat.kind)}
      ${fact('Workspace', chat.workspacePaths.join(', ') || '(unknown)')}
      ${fact('Repository', chat.repositoryUrl ?? '(unknown)')}
      ${fact('Branch', chat.branch ?? '(unknown)')}
      ${fact('Chat key', chat.chatKey)}
      ${fact('Provider chat ID', chat.providerChatId)}
      ${fact('Source', detail.source?.path ?? chat.sourcePath)}
      ${fact('Records / invalid', `${formatNumber(detail.source?.recordsRead ?? 0)} / ${formatNumber(detail.source?.invalidRecords ?? 0)}`)}
      ${fact('Data quality', chat.dataQuality.confidence)}
      ${fact('Token semantics', chat.tokens.totalTokenSemantics)}
    </div>
  </section>`
}

function renderSnapshotNotice(
  detail: ChatDetailReport,
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
): string {
  const generatedAt = formatTimestamp(detail.generatedAt)
  const refresh =
    navigation === 'command' && detail.metadata
      ? `<a class="snapshot-action" href="${escapeHtml(chatSnapshotRefreshHref(detail.metadata))}">Refresh snapshot</a>`
      : ''
  return `<div class="snapshot-notice">
    <div class="snapshot-copy"><strong>Chat snapshot</strong> &middot; captured ${escapeHtml(generatedAt)}. Background changes do not replace this view.</div>
    ${refresh}
  </div>`
}

function renderChatDetailControls(
  detail: ChatDetailReport,
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
  contentEnabled: boolean,
): string {
  if (!detail.metadata || navigation === 'none') return ''
  return `<div class="detail-controls">
    <span class="detail-control-note">${
      contentEnabled
        ? `${escapeHtml(detail.privacy.warning)} Content is read locally, limited to ${formatNumber(detail.privacy.maxContentCharsPerField)} characters per field, and is not persisted by this view.`
        : 'Captured content is disabled while VS Code is in Restricted Mode.'
    }</span>
  </div>`
}

function chatSnapshotRefreshHref(chat: ChatMetadata): string {
  return commandHref('breadcrumbs.refreshChatSnapshot', {
    provider: chat.provider,
    chatKey: chat.chatKey,
  })
}

function timelineContentDescription(detail: ChatDetailReport): string {
  if (detail.privacy.contentMode === 'none') return 'Captured event content is hidden.'
  return 'All supported captured event excerpts are shown within the per-field limit.'
}

function contextContentDescription(detail: ChatDetailReport): string {
  if (detail.privacy.contentMode === 'none') {
    return 'Context categories, sources, and observed sizes are shown. Captured context text is hidden in Restricted Mode.'
  }
  return 'Captured instructions, attachments, and other context are shown when the provider stored them.'
}

function chatNotes(detail: ChatDetailReport): string[] {
  const chat = detail.metadata
  if (!chat) return []
  const notes: string[] = []
  if ((detail.summary?.omittedTimelineEvents ?? 0) > 0) {
    notes.push(
      `${formatNumber(detail.summary?.omittedTimelineEvents ?? 0)} timeline events are omitted by the configured display limit.`,
    )
  }
  if ((detail.source?.invalidRecords ?? 0) > 0) {
    notes.push(`${formatNumber(detail.source?.invalidRecords ?? 0)} source records could not be parsed.`)
  }
  for (const caveat of chat.dataQuality.caveats) notes.push(caveat)
  return notes
}

function renderContextEntry(entry: ChatDetailReport['context'][number]): string {
  const { content } = entry
  const contentVisible = content?.text !== undefined && content.emittedChars > 0
  const contentState = content
    ? contentVisible
      ? content.truncated
        ? `${formatNumber(content.emittedChars)} of ${formatNumber(content.originalChars)} chars shown`
        : `${formatNumber(content.emittedChars)} chars shown`
      : content.originalChars > 0
        ? `${formatNumber(content.originalChars)} chars hidden`
        : 'Hidden'
    : 'Not captured'
  return `<article class="detail-entry">
    <div class="detail-entry-header">
      <div class="detail-entry-title">${escapeHtml(entry.label)}</div>
      <div class="detail-entry-meta">${escapeHtml(entry.kind.replaceAll('_', ' '))}</div>
    </div>
    <div class="detail-entry-description">${escapeHtml(entry.source ?? '(unknown source)')}</div>
    <div class="detail-fields">
      ${chatField('Observed size', content ? formatNumber(content.originalChars) : 'n/a', true)}
      ${chatField('Content', contentState)}
    </div>
    ${
      contentVisible && content
        ? `<div class="captured-content">
      <div class="captured-content-label">Captured context${content.truncated ? ' (truncated)' : ''}</div>
      <pre>${escapeHtml(content.text)}</pre>
    </div>`
        : ''
    }
  </article>`
}

function renderModelDetail(model: ChatMetadata['models'][number], totalTokens: number): string {
  return `<article class="detail-entry">
    <div class="detail-entry-header">
      <div class="detail-entry-title">${escapeHtml(model.model)}</div>
      <div class="detail-entry-meta">${escapeHtml(formatPercent(model.totalTokens, totalTokens))} of chat tokens</div>
    </div>
    <div class="detail-fields">
      ${chatField('Requests', formatNumber(model.requests), true)}
      ${chatField('Input', formatNumber(model.inputTokens), true)}
      ${chatField('Cached', formatNumber(model.cachedInputTokens), true)}
      ${chatField('Output', formatNumber(model.outputTokens), true)}
      ${chatField('Reasoning', formatNumber(model.reasoningOutputTokens), true)}
      ${chatField('Total', formatNumber(model.totalTokens), true)}
      ${chatField('Duration', formatDuration(model.durationMs))}
    </div>
  </article>`
}
