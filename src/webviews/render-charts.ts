import { chartColor, type ChartFrame } from './render-primitives.js'

/** Chart frame whose height scales with the number of horizontal bars. */
export function barFrame(count: number): ChartFrame {
  if (count <= 3) return 'bars-sm'
  if (count <= 6) return 'bars-md'
  if (count <= 10) return 'bars-lg'
  return 'bars-xl'
}

/** Horizontal single-series bar chart: one bar per entry. */
export function categoryBarChart(entries: Array<[string, number]>, colorIndex: number, seriesLabel = 'Count'): unknown {
  return {
    type: 'bar',
    data: {
      labels: entries.map(([label]) => label),
      datasets: [
        {
          label: seriesLabel,
          data: entries.map(([, value]) => value),
          backgroundColor: chartColor(colorIndex, 0.68),
          borderColor: chartColor(colorIndex),
          borderWidth: 1,
          maxBarThickness: 44,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      scales: { x: { beginAtZero: true } },
      plugins: { legend: { display: false } },
    },
  }
}

/** Part-of-whole doughnut chart for share-of-total breakdowns. */
export function doughnutChart(slices: { labels: string[]; values: number[] }): unknown {
  return {
    type: 'doughnut',
    data: {
      labels: slices.labels,
      datasets: [
        {
          data: slices.values,
          backgroundColor: slices.labels.map((_, index) => chartColor(index, 0.72)),
          borderColor: slices.labels.map((_, index) => chartColor(index)),
          borderWidth: 1,
        },
      ],
    },
    options: { cutout: '58%', plugins: { legend: { position: 'right' } } },
  }
}

/** Top `max` entries by value; the remainder is grouped into a single "Other" slice. */
export function topSlices(entries: Array<[string, number]>, max = 7): { labels: string[]; values: number[] } {
  const positive = entries.filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1])
  const visible = positive.slice(0, max)
  const labels = visible.map(([label]) => label)
  const values = visible.map(([, value]) => value)
  const other = positive.slice(max).reduce((total, [, value]) => total + value, 0)
  if (other > 0) {
    labels.push('Other')
    values.push(other)
  }
  return { labels, values }
}

/** Single horizontal stacked bar: each slice is one segment of the same bar. */
export function singleBarChart(slices: Array<[string, number]>, colorOffset: number): unknown {
  const visible = slices.filter(([, value]) => value > 0)
  return {
    type: 'bar',
    data: {
      labels: [''],
      datasets: visible.map(([label, value], index) => ({
        label,
        data: [value],
        backgroundColor: chartColor(colorOffset + index, 0.72),
        borderColor: chartColor(colorOffset + index),
        borderWidth: 1,
        barThickness: 28,
      })),
    },
    options: {
      indexAxis: 'y',
      scales: { x: { stacked: true, beginAtZero: true }, y: { stacked: true } },
    },
  }
}
