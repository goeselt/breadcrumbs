import type { AgentId } from '../agent.js'
import type { ChatMetadata, ChatMetadataReport, TokenUsage } from '../chat-metadata.js'
import { singleBarChart } from './render-charts.js'
import {
  chartPanel,
  escapeHtml,
  formatNumber,
  formatPercent,
  metric,
  providerLabel,
  workspaceLabel,
} from './render-primitives.js'
import type { ProviderReportResult } from './types.js'

/** Total tokens summed per workspace, descending, capped to `limit` entries. */
export function tokensByWorkspace(chats: ChatMetadata[], limit = 10): Array<[string, number]> {
  const byWorkspace = new Map<string, number>()
  for (const chat of chats) {
    const label = workspaceLabel(chat)
    byWorkspace.set(label, (byWorkspace.get(label) ?? 0) + chat.tokens.totalTokens)
  }
  return [...byWorkspace]
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
}

export interface ProviderSignal {
  label: string
  value: string
  code?: boolean
}

export function renderProviderUnavailable(provider: ProviderReportResult | undefined, providerId: AgentId): string {
  if (provider?.loading) {
    return '<div class="empty loading">Usage data is loading. Please wait a moment.</div>'
  }
  return `<div class="error">${escapeHtml(provider?.error ?? `${providerLabel(providerId)} data is unavailable.`)}</div>`
}

export function cacheShare(tokens: ChatMetadataReport['totals']['tokens']): string {
  const denominator = tokens.totalTokenSemantics.includes('cached_input_is_a_subset_of_input')
    ? tokens.inputTokens
    : tokens.inputTokens + tokens.cachedInputTokens + tokens.cacheCreationInputTokens
  return denominator > 0 ? `${((tokens.cachedInputTokens / denominator) * 100).toFixed(1)}%` : 'n/a'
}

export function providerTokenMetrics(provider: AgentId, tokens: ChatMetadataReport['totals']['tokens']): string {
  if (provider === 'codex') {
    return [
      metric('Input', formatNumber(tokens.inputTokens)),
      metric('Cached input subset', formatNumber(tokens.cachedInputTokens)),
      metric('Output', formatNumber(tokens.outputTokens)),
      metric('Reasoning output', formatNumber(tokens.reasoningOutputTokens)),
    ].join('')
  }
  if (provider === 'claude') {
    return [
      metric('Uncached input', formatNumber(tokens.inputTokens)),
      metric('Cache read', formatNumber(tokens.cachedInputTokens)),
      metric('Cache creation', formatNumber(tokens.cacheCreationInputTokens)),
      metric('Output', formatNumber(tokens.outputTokens)),
    ].join('')
  }
  return [
    metric('Input', formatNumber(tokens.inputTokens)),
    metric('Cache read', formatNumber(tokens.cachedInputTokens)),
    metric('Cache creation', formatNumber(tokens.cacheCreationInputTokens)),
    metric('Output', formatNumber(tokens.outputTokens)),
    metric('Reasoning output', formatNumber(tokens.reasoningOutputTokens)),
  ].join('')
}

/**
 * Non-overlapping prompt/completion token buckets. For Codex, cachedInputTokens is a subset of inputTokens,
 * and reasoningOutputTokens is a subset of outputTokens for every provider.
 */
export function tokenComponents(
  provider: AgentId,
  tokens: TokenUsage,
): { prompt: Array<[string, number]>; completion: Array<[string, number]> } {
  const prompt: Array<[string, number]> =
    provider === 'codex'
      ? [
          ['Uncached input', Math.max(tokens.inputTokens - tokens.cachedInputTokens, 0)],
          ['Cached input', tokens.cachedInputTokens],
        ]
      : [
          ['Uncached input', tokens.inputTokens],
          ['Cache read', tokens.cachedInputTokens],
          ['Cache creation', tokens.cacheCreationInputTokens],
        ]
  const completion: Array<[string, number]> = [
    ['Output', Math.max(tokens.outputTokens - tokens.reasoningOutputTokens, 0)],
    ['Reasoning', tokens.reasoningOutputTokens],
  ]
  return { prompt, completion }
}

/** Efficiency metrics plus side-by-side Prompt/Completion token bars. */
export function renderTokenComposition(provider: AgentId, tokens: TokenUsage): string {
  if (tokens.totalTokens <= 0) {
    return `<div class="summary">${providerTokenMetrics(provider, tokens)}</div>`
  }
  const efficiency = [
    metric('Cache hit rate', cacheShare(tokens)),
    metric('Output share', formatPercent(tokens.outputTokens, tokens.totalTokens)),
    metric('Reasoning / output', formatPercent(tokens.reasoningOutputTokens, tokens.outputTokens)),
  ].join('')
  const { prompt, completion } = tokenComponents(provider, tokens)
  return `<div class="summary">${efficiency}</div>
  <div class="chart-grid">
    ${chartPanel('Prompt tokens', 'prompt-composition-chart', singleBarChart(prompt, 0), 'slim')}
    ${chartPanel('Completion tokens', 'completion-composition-chart', singleBarChart(completion, 3), 'slim')}
  </div>`
}
