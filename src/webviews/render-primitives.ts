import type { AgentId } from '../agent.js'
import type { ChatMetadata } from '../chat-metadata.js'
import type { ReportViewData } from './types.js'

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function escapeJsonForHtml(value: unknown): string {
  return escapeHtml(JSON.stringify(value).replaceAll('<', '\\u003c'))
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

export function formatDate(value: string | undefined): string {
  if (!value) return '(unknown)'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString()
}

export function formatTimestamp(value: string | undefined): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return value
  const date = [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0'),
  ].join('-')
  const time = [
    String(parsed.getHours()).padStart(2, '0'),
    String(parsed.getMinutes()).padStart(2, '0'),
    String(parsed.getSeconds()).padStart(2, '0'),
  ].join(':')
  return `${date} ${time}`
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined) return 'n/a'
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`
  return `${(value / 60_000).toFixed(1)} min`
}

export function formatPercent(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : 'n/a'
}

export function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? 'n/a' : formatNumber(value)
}

export function countLabel(value: number, singular: string): string {
  return `${formatNumber(value)} ${singular}${value === 1 ? '' : 's'}`
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

export function maxDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined)
  return defined.length > 0 ? Math.max(...defined) : undefined
}

export function averageDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined)
  return defined.length > 0 ? sum(defined) / defined.length : undefined
}

export function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

export function metric(label: string, value: string): string {
  return `<div class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div></div>`
}

export function chartColor(index: number, alpha = 0.88): string {
  const palette = [
    [74, 163, 255],
    [74, 222, 128],
    [250, 204, 21],
    [248, 113, 113],
    [168, 85, 247],
    [45, 212, 191],
    [251, 146, 60],
    [244, 114, 182],
  ]
  const value = palette[index % palette.length]
  return `rgba(${value[0]}, ${value[1]}, ${value[2]}, ${alpha})`
}

/** Empty-state message with optional next-step command links so the view is not a dead end. */
export function emptyState(message: string, actions: Array<{ label: string; command: string }> = []): string {
  const links = actions
    .map(
      (action) =>
        `<a class="empty-action" href="command:${escapeHtml(action.command)}">${escapeHtml(action.label)}</a>`,
    )
    .join('')
  return `<div class="empty">${escapeHtml(message)}${actions.length > 0 ? `<div class="empty-actions">${links}</div>` : ''}</div>`
}

export type ChartFrame = 'default' | 'slim' | 'bars-sm' | 'bars-md' | 'bars-lg' | 'bars-xl'

export function chartPanel(title: string, id: string, config: unknown, frame: ChartFrame = 'default'): string {
  const frameClass = frame === 'default' ? '' : ` chart-frame--${frame}`
  return `<section class="chart-panel">
    <h3>${escapeHtml(title)}</h3>
    <div class="chart-frame${frameClass}"><canvas id="${escapeHtml(id)}" data-chart role="img" aria-label="${escapeHtml(title)} chart"></canvas></div>
    <template class="chart-config" data-chart-target="${escapeHtml(id)}">${escapeJsonForHtml(config)}</template>
  </section>`
}

export function fact(label: string, value: string, code = false): string {
  const renderedValue = code
    ? `<code class="fact-value">${escapeHtml(value)}</code>`
    : `<div class="fact-value">${escapeHtml(value)}</div>`
  return `<div class="fact"><div class="fact-label">${escapeHtml(label)}</div>${renderedValue}</div>`
}

export function chatField(label: string, value: string, numeric = false): string {
  return `<div class="chat-field">
    <div class="chat-field-label">${escapeHtml(label)}</div>
    <div class="chat-field-value${numeric ? ' number' : ''}">${escapeHtml(value)}</div>
  </div>`
}

export function providerLabel(provider: AgentId): string {
  if (provider === 'copilot') return 'GitHub Copilot'
  if (provider === 'codex') return 'Codex'
  return 'Claude Code'
}

export function providerChatsTitle(provider: AgentId): string {
  return provider === 'copilot' ? 'GitHub Copilot Chats' : `${providerLabel(provider)} Chats`
}

export function providerChatDetailTitle(provider: AgentId): string {
  return provider === 'copilot' ? 'GitHub Copilot Chat Detail' : `${providerLabel(provider)} Chat`
}

export function commandHref(command: string, argument: unknown): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([argument]))}`
}

export function chatDetailCommandHref(chat: Pick<ChatMetadata, 'provider' | 'chatKey'>): string {
  return commandHref('breadcrumbs.openChatDetail', {
    provider: chat.provider,
    chatKey: chat.chatKey,
  })
}

export function workspaceLabel(chat: ChatMetadata): string {
  const workspace = chat.workspacePaths[0]
  if (!workspace) return '(unknown)'
  const parts = workspace.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.at(-1) ?? workspace
}

export function modelLabel(chat: ChatMetadata): string {
  if (chat.models.length === 0) return '(unknown)'
  if (chat.models.length === 1) return chat.models[0].model
  const primary = chat.models.slice().sort((a, b) => b.totalTokens - a.totalTokens)[0]
  return `${primary.model} +${chat.models.length - 1}`
}

export function chatMetadataStrings(chat: ChatMetadata, key: string): string {
  const value = chat.providerMetadata[key]
  if (typeof value === 'string' && value) return value
  if (Array.isArray(value)) {
    const strings = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    if (strings.length > 0) return strings.join(', ')
  }
  return 'n/a'
}

export function chatServerToolRequests(chat: ChatMetadata): number {
  const { serverToolUse } = chat.providerMetadata
  if (typeof serverToolUse !== 'object' || serverToolUse === null || Array.isArray(serverToolUse)) return 0
  const values = serverToolUse as Record<string, unknown>
  return ['webFetchRequests', 'webSearchRequests'].reduce((total, key) => {
    const value = values[key]
    return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  }, 0)
}

export function shortChatId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 15)}...` : value
}

export function displayChatTitle(chat: ChatMetadata): string {
  if (chat.title?.trim()) return chat.title.trim()
  const workspace = workspaceLabel(chat)
  if (workspace !== '(unknown)') return `${workspace} chat`
  return `${providerLabel(chat.provider)} ${shortChatId(chat.providerChatId)}`
}

export function chatTitleText(chat: ChatMetadata): string {
  const title = displayChatTitle(chat)
  return `<div class="chat-entry-title" title="${escapeHtml(truncateText(title, 240))}">${escapeHtml(truncateText(title, 140))}</div>`
}

export function chatList(entries: string[]): string {
  return `<div class="chat-list">${entries.join('')}</div>`
}

export function chatEntry(
  chat: ChatMetadata,
  metadata: string[],
  fields: string[],
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
): string {
  return `<article class="chat-entry">
    <div class="chat-entry-header">
      <div class="chat-entry-heading">
        ${chatTitleText(chat)}
        <div class="chat-entry-meta">${metadata.map(escapeHtml).join(' &middot; ')}</div>
      </div>
      <div class="chat-entry-actions">
        <time class="chat-entry-date" datetime="${escapeHtml(chat.startedAt ?? '')}">${escapeHtml(formatDate(chat.startedAt))}</time>
        ${chatDetailAction(chat, navigation)}
      </div>
    </div>
    <div class="chat-fields">${fields.join('')}</div>
  </article>`
}

export function chatDetailAction(
  chat: ChatMetadata,
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
): string {
  if (navigation === 'none') return ''
  const href = chatDetailCommandHref(chat)
  return `<a class="chat-entry-action" href="${escapeHtml(href)}" aria-label="Open details for ${escapeHtml(displayChatTitle(chat))}">Details</a>`
}
