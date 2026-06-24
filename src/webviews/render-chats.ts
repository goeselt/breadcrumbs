import type { AgentId } from '../agent.js'
import type { ChatMetadata } from '../chat-metadata.js'
import {
  chatEntry,
  chatField,
  chatMetadataStrings,
  chatList,
  chatServerToolRequests,
  emptyState,
  formatDuration,
  formatNumber,
  formatOptionalNumber,
  formatPercent,
  metric,
  modelLabel,
  providerLabel,
  timestamp,
  workspaceLabel,
} from './render-primitives.js'
import { renderProviderUnavailable } from './render-shared.js'
import type { ProviderReportResult, ReportViewData } from './types.js'

export function renderChats(
  providers: ProviderReportResult[],
  selectedProvider: AgentId | undefined,
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
): string {
  const selectedReports = selectedProvider
    ? providers.filter((provider) => provider.provider === selectedProvider)
    : providers
  if (selectedProvider && !selectedReports[0]?.report) {
    return renderProviderUnavailable(selectedReports[0], selectedProvider)
  }
  const chats = selectedReports
    .flatMap((provider) => provider.report?.chats ?? [])
    .filter((chat) => chat.requests > 0)
    .sort((a, b) => timestamp(b.startedAt) - timestamp(a.startedAt))
  if (chats.length === 0) {
    return emptyState('No indexed chats are available yet.', [
      { label: 'Refresh index', command: 'breadcrumbs.refreshIndex' },
      { label: 'Inspect sources', command: 'breadcrumbs.openSources' },
    ])
  }

  const selectedReport = selectedProvider
    ? selectedReports.find((provider) => provider.provider === selectedProvider)?.report
    : undefined
  const selectedTokens =
    selectedProvider === 'claude'
      ? (selectedReport?.totalsIncludingChildren?.tokens.totalTokens ?? selectedReport?.totals.tokens.totalTokens ?? 0)
      : (selectedReport?.totals.tokens.totalTokens ?? 0)
  const chatEntries = selectedProvider
    ? renderProviderChatList(selectedProvider, chats, selectedTokens, navigation)
    : renderAllChatList(chats, navigation)

  return `${
    selectedProvider && selectedReport
      ? `<div class="summary">
      ${metric('Chats with requests', formatNumber(chats.length))}
      ${metric('Main chats', formatNumber(chats.filter((chat) => chat.kind === 'main').length))}
      ${metric('Requests', formatNumber(selectedReport.totals.requests))}
      ${metric(selectedProvider === 'claude' ? 'Tokens incl. subagents' : 'Total tokens', formatNumber(selectedTokens))}
    </div>`
      : `<div class="summary">
      ${metric('Chats with requests', formatNumber(chats.length))}
      ${metric('Main chats', formatNumber(chats.filter((chat) => chat.kind === 'main').length))}
      ${metric('Subagents', formatNumber(chats.filter((chat) => chat.kind === 'subagent').length))}
      ${metric('Providers', formatNumber(new Set(chats.map((chat) => chat.provider)).size))}
    </div>`
  }
  ${chatEntries}`
}

function renderAllChatList(
  chats: ChatMetadata[],
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
): string {
  return chatList(
    chats.map((chat) =>
      chatEntry(
        chat,
        [providerLabel(chat.provider), workspaceLabel(chat), chat.kind],
        [
          chatField('Model', modelLabel(chat)),
          chatField('Requests', formatNumber(chat.requests), true),
          chatField('Tokens', formatNumber(chat.tokens.totalTokens), true),
          chatField('Duration', formatDuration(chat.wallClockDurationMs)),
          chatField('Quality', chat.dataQuality.confidence),
        ],
        navigation,
      ),
    ),
  )
}

function renderProviderChatList(
  provider: AgentId,
  chats: ChatMetadata[],
  providerTokens: number,
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
): string {
  if (provider === 'copilot') return renderCopilotChats(chats, providerTokens, navigation)
  if (provider === 'codex') return renderCodexChats(chats, providerTokens, navigation)
  return renderClaudeChats(chats, providerTokens, navigation)
}

function renderCopilotChats(
  chats: ChatMetadata[],
  providerTokens: number,
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
): string {
  return chatList(
    chats.map((chat) =>
      chatEntry(
        chat,
        [workspaceLabel(chat), modelLabel(chat)],
        [
          chatField('Agent', chatMetadataStrings(chat, 'agentNames')),
          chatField('Requests', formatNumber(chat.requests), true),
          chatField('Turns', formatOptionalNumber(chat.turns), true),
          chatField('Tools', formatNumber(chat.tools?.calls ?? 0), true),
          chatField('Cached', formatNumber(chat.tokens.cachedInputTokens), true),
          chatField('Tokens', formatNumber(chat.tokens.totalTokens), true),
          chatField('Provider share', formatPercent(chat.tokens.totalTokens, providerTokens), true),
          chatField('Quality', chat.dataQuality.confidence),
        ],
        navigation,
      ),
    ),
  )
}

function renderCodexChats(
  chats: ChatMetadata[],
  providerTokens: number,
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
): string {
  return chatList(
    chats.map((chat) =>
      chatEntry(
        chat,
        [workspaceLabel(chat), modelLabel(chat)],
        [
          chatField('Requests', formatNumber(chat.requests), true),
          chatField('Turns', formatOptionalNumber(chat.turns), true),
          chatField(
            'Reasoning share',
            formatPercent(chat.tokens.reasoningOutputTokens, chat.tokens.outputTokens),
            true,
          ),
          chatField('Context window', formatOptionalNumber(chat.modelContextWindow), true),
          chatField('Average TTFT', formatDuration(chat.performance?.averageTimeToFirstTokenMs)),
          chatField('Plan', chatMetadataStrings(chat, 'planType')),
          chatField('Tokens', formatNumber(chat.tokens.totalTokens), true),
          chatField('Provider share', formatPercent(chat.tokens.totalTokens, providerTokens), true),
          chatField('Quality', chat.dataQuality.confidence),
        ],
        navigation,
      ),
    ),
  )
}

function renderClaudeChats(
  chats: ChatMetadata[],
  providerTokens: number,
  navigation: NonNullable<ReportViewData['chatDetailNavigation']>,
): string {
  return chatList(
    chats.map((chat) =>
      chatEntry(
        chat,
        [workspaceLabel(chat), modelLabel(chat), chat.kind],
        [
          chatField('Requests', formatNumber(chat.requests), true),
          chatField('Cache creation', formatNumber(chat.tokens.cacheCreationInputTokens), true),
          chatField('Cache read', formatNumber(chat.tokens.cachedInputTokens), true),
          chatField('Output', formatNumber(chat.tokens.outputTokens), true),
          chatField('Web tools', formatNumber(chatServerToolRequests(chat)), true),
          chatField('Tokens', formatNumber(chat.tokens.totalTokens), true),
          chatField('Provider share', formatPercent(chat.tokens.totalTokens, providerTokens), true),
          chatField('Quality', chat.dataQuality.confidence),
        ],
        navigation,
      ),
    ),
  )
}
