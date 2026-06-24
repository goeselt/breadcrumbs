import type { ChatDetailReport } from '../chat-detail.js'
import type { ChatMetadata, ToolUsage } from '../chat-metadata.js'
import { categoryBarChart, singleBarChart } from './render-charts.js'
import { chartColor, chartPanel } from './render-primitives.js'
import { detailNumber } from './render-timeline.js'

export function renderModelComposition(chat: ChatMetadata): string {
  const slices = chat.models
    .filter((model) => model.totalTokens > 0)
    .map((model): [string, number] => [model.model, model.totalTokens])
  if (slices.length === 0) return ''
  return `<div class="chart-grid">
    ${chartPanel('Model token mix', 'model-composition-chart', singleBarChart(slices, 0), 'slim')}
  </div>`
}

export function renderToolUsage(tools: ToolUsage | undefined): string {
  const byTool = (tools?.byTool ?? []).filter((tool) => tool.calls > 0)
  if (byTool.length === 0) return ''
  return `<div class="chart-grid">
    ${chartPanel('Tool usage', 'tool-usage-chart', toolUsageChart(byTool))}
  </div>`
}

export function renderObservedActivity(detail: ChatDetailReport): string {
  const eventEntries = Object.entries(detail.summary?.eventKinds ?? {})
    .map(([kind, count]): [string, number] => [kind.replaceAll('_', ' '), count])
    .sort((a, b) => b[1] - a[1])
  const observed = detail.summary?.contentCharsObserved ?? 0
  const emitted = detail.summary?.contentCharsEmitted ?? 0
  const panels = [
    eventEntries.length > 0 ? chartPanel('Event types', 'event-types-chart', categoryBarChart(eventEntries, 4)) : '',
    observed > 0 || emitted > 0
      ? chartPanel(
          'Content characters',
          'content-chars-chart',
          categoryBarChart(
            [
              ['Observed', observed],
              ['Emitted', emitted],
            ],
            1,
          ),
        )
      : '',
  ].filter(Boolean)
  if (panels.length === 0) return '<div class="empty">No structural activity was observed.</div>'
  return `<div class="chart-grid">${panels.join('')}</div>`
}

/**
 * Per-iteration development charts: total request tokens (lead, full width) followed by the most
 * informative per-provider signals across model iterations.
 */
export function renderProviderTimeline(detail: ChatDetailReport, chat: ChatMetadata): string {
  const requests = detail.timeline.filter((event) => event.kind === 'model_request' && event.usage)
  const turns = detail.timeline.filter((event) => event.kind === 'turn' && event.durationMs !== undefined)
  const tokenUsage = timelineTokenChart(detail)
  const panels: string[] = []
  const addCombo = (
    id: string,
    title: string,
    cumulativeLabel: string,
    values: number[],
    barColor: number,
    pointNoun: string,
  ) => {
    if (values.length < 2 || values.every((value) => value === 0)) return
    panels.push(chartPanel(title, id, iterationComboChart(values, title, cumulativeLabel, barColor, 3, pointNoun)))
  }
  const addLine = (id: string, title: string, values: number[], colorIndex: number, pointNoun: string) => {
    if (values.length < 2 || values.every((value) => value === 0)) return
    panels.push(chartPanel(title, id, iterationLineChart(values, title, colorIndex, pointNoun)))
  }
  if (chat.provider === 'claude') {
    addCombo('signal-cache-read-chart', 'Cache read tokens', 'Cumulative', requests.map((event) => event.usage?.cachedInputTokens ?? 0), 1, 'Request')
    addCombo('signal-cache-creation-chart', 'Cache creation tokens', 'Cumulative', requests.map((event) => event.usage?.cacheCreationInputTokens ?? 0), 2, 'Request')
  } else if (chat.provider === 'codex') {
    const contextUsage = requests.map((event) => {
      const window = detailNumber(event, 'modelContextWindow') ?? 0
      return window > 0 ? Math.round(((event.usage?.totalTokens ?? 0) / window) * 1000) / 10 : 0
    })
    addLine('signal-context-usage-chart', 'Context window usage %', contextUsage, 4, 'Request')
    addCombo('signal-model-duration-chart', 'Model duration (ms)', 'Cumulative ms', turns.map((event) => event.durationMs ?? 0), 0, 'Turn')
  } else {
    addCombo('signal-output-chart', 'Output tokens', 'Cumulative', requests.map((event) => event.usage?.outputTokens ?? 0), 0, 'Request')
    addCombo('signal-cache-read-chart', 'Cache read tokens', 'Cumulative', requests.map((event) => event.usage?.cachedInputTokens ?? 0), 1, 'Request')
  }
  if (!tokenUsage && panels.length === 0) return ''
  return `<h2>Signals over iterations</h2>
  ${tokenUsage ? `<div class="chart-grid">${chartPanel('Token usage over requests', 'timeline-token-chart', tokenUsage)}</div>` : ''}
  ${panels.length > 0 ? `<div class="chart-grid">${panels.join('')}</div>` : ''}`
}

function toolUsageChart(byTool: NonNullable<ToolUsage['byTool']>): unknown {
  const tools = byTool
    .slice()
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 12)
  return categoryBarChart(
    tools.map((tool) => [tool.tool, tool.calls]),
    1,
  )
}

function timelineTokenChart(detail: ChatDetailReport): unknown | undefined {
  const requests = detail.timeline.filter((event) => event.kind === 'model_request' && event.usage)
  if (requests.length < 2) return undefined
  const partial = (detail.summary?.omittedTimelineEvents ?? 0) > 0
  const values = requests.map((event) => event.usage?.totalTokens ?? 0)
  return iterationComboChart(
    values,
    'Request tokens',
    partial ? 'Visible cumulative tokens' : 'Cumulative tokens',
    0,
    3,
    'Request',
  )
}

/** Per-iteration bar plus a cumulative line on a secondary axis. */
function iterationComboChart(
  values: number[],
  barLabel: string,
  cumulativeLabel: string,
  barColor: number,
  lineColor: number,
  pointNoun: string,
): unknown {
  const labels = values.map((_, index) => `${pointNoun} ${index + 1}`)
  let running = 0
  const cumulative = values.map((value) => (running += value))
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: barLabel,
          data: values,
          backgroundColor: chartColor(barColor, 0.68),
          borderColor: chartColor(barColor),
          borderWidth: 1,
          yAxisID: 'value',
        },
        {
          type: 'line',
          label: cumulativeLabel,
          data: cumulative,
          borderColor: chartColor(lineColor),
          backgroundColor: chartColor(lineColor, 0.18),
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.25,
          fill: false,
          yAxisID: 'cumulative',
        },
      ],
    },
    options: {
      interaction: { intersect: false, mode: 'index' },
      scales: {
        value: { beginAtZero: true, position: 'left', ticks: { color: chartColor(barColor) } },
        cumulative: {
          beginAtZero: true,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: chartColor(lineColor) },
        },
      },
    },
  }
}

/** Single-axis line over iterations, for metrics where accumulation is meaningless. */
function iterationLineChart(values: number[], label: string, colorIndex: number, pointNoun: string): unknown {
  const labels = values.map((_, index) => `${pointNoun} ${index + 1}`)
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label,
          data: values,
          borderColor: chartColor(colorIndex),
          backgroundColor: chartColor(colorIndex, 0.18),
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      scales: { y: { beginAtZero: true, ticks: { color: chartColor(colorIndex) } } },
      plugins: { legend: { display: false } },
    },
  }
}
