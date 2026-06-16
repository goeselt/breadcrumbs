import type { AgentId } from '../agent.js'
import type { ChatMetadataReport } from '../chat-metadata.js'
import { escapeHtml, formatNumber, metric, providerLabel } from './render-primitives.js'
import type { ProviderReportResult } from './types.js'

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
