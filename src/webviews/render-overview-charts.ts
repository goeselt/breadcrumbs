import type { AgentId } from '../agent.js'
import type { ChatMetadata, ChatMetadataReport } from '../chat-metadata.js'
import { chartColor as color, providerLabel, sum } from './render-primitives.js'
import type { ProviderReportResult } from './types.js'

const PROVIDER_COLOR_ORDER: AgentId[] = ['claude', 'codex', 'copilot']

/** Stacked daily token usage with one colored series per provider, sharing one day axis. */
export function providerDailyChart(providers: Array<ProviderReportResult & { report: ChatMetadataReport }>): unknown {
  const labels = dailyLabels(providers.flatMap((provider) => provider.report.chats))
  const datasets = providers.map((provider) => {
    const buckets = new Map<string, number>()
    for (const chat of provider.report.chats) {
      const key = dateKey(chat.startedAt ?? chat.endedAt)
      if (!key) continue
      buckets.set(key, (buckets.get(key) ?? 0) + chat.tokens.totalTokens)
    }
    const colorIndex = Math.max(0, PROVIDER_COLOR_ORDER.indexOf(provider.provider))
    return {
      label: providerLabel(provider.provider),
      data: labels.map((label) => buckets.get(label) ?? 0),
      backgroundColor: color(colorIndex, 0.7),
      borderColor: color(colorIndex),
      borderWidth: 1,
      stack: 'tokens',
    }
  })
  return {
    type: 'bar',
    data: { labels, datasets },
    options: {
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, ticks: { format: { notation: 'compact', maximumFractionDigits: 1 } } },
      },
    },
  }
}

export function toolUsageEntries(chats: ChatMetadata[]): Array<[string, number]> {
  const byTool = new Map<string, number>()
  for (const chat of chats) {
    for (const tool of chat.tools?.byTool ?? []) {
      byTool.set(tool.tool, (byTool.get(tool.tool) ?? 0) + tool.calls)
    }
  }
  return [...byTool]
    .filter(([, calls]) => calls > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
}

/** Sorted unique day keys (YYYY-MM-DD) across the chats, used as a shared x scale. */
export function dailyLabels(chats: ChatMetadata[]): string[] {
  const days = new Set<string>()
  for (const chat of chats) {
    const key = dateKey(chat.startedAt ?? chat.endedAt)
    if (key) days.add(key)
  }
  return [...days].sort((a, b) => a.localeCompare(b))
}

/** Per-day totals for the shared day labels (0 where a day has no data). */
export function dailyTotals(chats: ChatMetadata[], labels: string[], pick: (chat: ChatMetadata) => number): number[] {
  const buckets = new Map<string, number>()
  for (const chat of chats) {
    const key = dateKey(chat.startedAt ?? chat.endedAt)
    if (!key) continue
    buckets.set(key, (buckets.get(key) ?? 0) + pick(chat))
  }
  return labels.map((label) => buckets.get(label) ?? 0)
}

/**
 * Single-axis day line chart shared by every time series (tokens, requests, reasoning %, cache %).
 * Using one chart type and one left y-axis (pinned by matchAxisWidth) keeps the day scale identical
 * across the stacked charts -- mixing bar and line types offsets the category axis differently.
 */
export function dayLineChart(
  labels: string[],
  data: number[],
  seriesLabel: string,
  colorIndex: number,
  opts: { max?: number; compact?: boolean } = {},
): unknown {
  const ticks = {
    color: color(colorIndex),
    ...(opts.compact ? { format: { notation: 'compact', maximumFractionDigits: 1 } } : {}),
  }
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: seriesLabel,
          data,
          borderColor: color(colorIndex),
          backgroundColor: color(colorIndex, 0.18),
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      matchAxisWidth: 60,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        y: { beginAtZero: true, ticks, ...(opts.max !== undefined ? { max: opts.max } : {}) },
      },
      plugins: { legend: { display: false } },
    },
  }
}

export function reasoningShareChart(chats: ChatMetadata[], labels: string[]): unknown | undefined {
  if (sum(chats.map((chat) => chat.tokens.reasoningOutputTokens)) === 0) return undefined
  const buckets = new Map<string, { reasoning: number; output: number }>()
  for (const chat of chats) {
    const key = dateKey(chat.startedAt ?? chat.endedAt)
    if (!key) continue
    const bucket = buckets.get(key) ?? { reasoning: 0, output: 0 }
    bucket.reasoning += chat.tokens.reasoningOutputTokens
    bucket.output += chat.tokens.outputTokens
    buckets.set(key, bucket)
  }
  const data = labels.map((label) => {
    const bucket = buckets.get(label)
    return bucket && bucket.output > 0 ? Math.round((bucket.reasoning / bucket.output) * 1000) / 10 : 0
  })
  return dayLineChart(labels, data, 'Reasoning share %', 4, { max: 100 })
}

export function cacheShareChart(chats: ChatMetadata[], labels: string[], subset: boolean): unknown | undefined {
  if (sum(chats.map((chat) => chat.tokens.cachedInputTokens)) === 0) return undefined
  const buckets = new Map<string, { cached: number; input: number; cacheCreation: number }>()
  for (const chat of chats) {
    const key = dateKey(chat.startedAt ?? chat.endedAt)
    if (!key) continue
    const bucket = buckets.get(key) ?? { cached: 0, input: 0, cacheCreation: 0 }
    bucket.cached += chat.tokens.cachedInputTokens
    bucket.input += chat.tokens.inputTokens
    bucket.cacheCreation += chat.tokens.cacheCreationInputTokens
    buckets.set(key, bucket)
  }
  const data = labels.map((label) => {
    const bucket = buckets.get(label)
    if (!bucket) return 0
    const denominator = subset ? bucket.input : bucket.input + bucket.cached + bucket.cacheCreation
    return denominator > 0 ? Math.round((bucket.cached / denominator) * 1000) / 10 : 0
  })
  return dayLineChart(labels, data, 'Cache hit rate %', 5, { max: 100 })
}

/** Vertical single-series bar chart for provider-level comparisons. */
export function barChart(labels: string[], label: string, values: number[], colorIndex: number): unknown {
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label,
          data: values,
          backgroundColor: color(colorIndex, 0.68),
          borderColor: color(colorIndex),
          borderWidth: 1,
        },
      ],
    },
    options: {
      scales: {
        y: { beginAtZero: true },
      },
    },
  }
}

function dateKey(value: string | undefined): string | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return undefined
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0'),
  ].join('-')
}
