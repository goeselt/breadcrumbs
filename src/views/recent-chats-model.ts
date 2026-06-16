import type { AgentId } from '../agent.js'
import type { ChatMetadata } from '../chat-metadata.js'

export interface RecentChatGroup {
  key: string
  label: string
  chats: ChatMetadata[]
}

export function buildRecentChatGroups(
  chats: ChatMetadata[],
  now = new Date(),
  provider?: AgentId,
  limit = 50,
): RecentChatGroup[] {
  const groups = new Map<string, RecentChatGroup>()
  const sorted = chats
    .filter((chat) => chat.kind === 'main' && chat.requests > 0 && (!provider || chat.provider === provider))
    .slice()
    .sort((left, right) => timestamp(right.startedAt) - timestamp(left.startedAt))
    .slice(0, limit)

  for (const chat of sorted) {
    const bucket = dateBucket(chat.startedAt, now)
    const group = groups.get(bucket.key) ?? { ...bucket, chats: [] }
    group.chats.push(chat)
    groups.set(bucket.key, group)
  }
  return [...groups.values()]
}

export function recentChatQuickPickLabel(chat: ChatMetadata): {
  label: string
  description: string
  detail: string
} {
  return {
    label: displayRecentChatTitle(chat),
    description: `${recentProviderLabel(chat.provider)} - ${formatRecentDate(chat.startedAt)} - ${compactRecentNumber(chat.tokens.totalTokens)} tokens`,
    detail: `${recentWorkspaceLabel(chat)} - ${chat.models.map((model) => model.model).join(', ') || 'unknown model'} - ${chat.requests} requests`,
  }
}

export function displayRecentChatTitle(chat: ChatMetadata): string {
  if (chat.title?.trim()) return chat.title.trim()
  const workspace = recentWorkspaceLabel(chat)
  return workspace !== '(unknown)'
    ? `${workspace} chat`
    : `${recentProviderLabel(chat.provider)} ${truncateRecentText(chat.providerChatId, 18)}`
}

export function recentWorkspaceLabel(chat: ChatMetadata): string {
  const workspace = chat.workspacePaths[0]
  if (!workspace) return '(unknown)'
  return workspace.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? workspace
}

export function recentProviderLabel(provider: AgentId): string {
  if (provider === 'copilot') return 'Copilot'
  if (provider === 'codex') return 'Codex'
  return 'Claude'
}

export function formatRecentTime(value: string | undefined): string {
  if (!value) return '--:--'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '--:--'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatRecentDate(value: string | undefined): string {
  if (!value) return '(unknown)'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

export function compactRecentNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function truncateRecentText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`
}

function dateBucket(value: string | undefined, now: Date): Omit<RecentChatGroup, 'chats'> {
  const date = value ? new Date(value) : undefined
  if (!date || Number.isNaN(date.valueOf())) return { key: 'unknown', label: 'Unknown Date' }
  const today = startOfDay(now).valueOf()
  const observed = startOfDay(date).valueOf()
  const days = Math.floor((today - observed) / 86_400_000)
  if (days <= 0) return { key: 'today', label: 'Today' }
  if (days === 1) return { key: 'yesterday', label: 'Yesterday' }
  if (days <= 7) return { key: 'week', label: 'Previous 7 Days' }
  return { key: 'older', label: 'Older' }
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}
