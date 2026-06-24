import { describe, expect, it } from 'vitest'
import type { ChatMetadata } from '../chat-metadata.js'
import { dailyLabels, dailyTotals, toolUsageEntries } from './render-overview-charts.js'

function chat(overrides: Partial<ChatMetadata>): ChatMetadata {
  return overrides as unknown as ChatMetadata
}

// Timezone-less datetime strings are parsed as local time, so dateKey is deterministic regardless
// of the environment's timezone (it derives the day from local getFullYear/Month/Date).
describe('dailyLabels', () => {
  it('returns sorted, unique day keys and ignores undated chats', () => {
    const labels = dailyLabels([
      chat({ startedAt: '2026-01-02T10:00:00' }),
      chat({ startedAt: '2026-01-01T09:00:00' }),
      chat({ startedAt: '2026-01-02T23:00:00' }),
      chat({ startedAt: undefined, endedAt: undefined }),
    ])
    expect(labels).toEqual(['2026-01-01', '2026-01-02'])
  })
})

describe('dailyTotals', () => {
  it('buckets values by day and zero-fills missing labels', () => {
    const chats = [
      chat({ startedAt: '2026-01-01T09:00:00', requests: 3 }),
      chat({ startedAt: '2026-01-01T18:00:00', requests: 2 }),
      chat({ startedAt: '2026-01-03T09:00:00', requests: 7 }),
    ]
    const labels = ['2026-01-01', '2026-01-02', '2026-01-03']
    expect(dailyTotals(chats, labels, (entry) => entry.requests)).toEqual([5, 0, 7])
  })
})

describe('toolUsageEntries', () => {
  it('aggregates calls per tool, sorts descending, and caps at twelve', () => {
    const chats = [
      chat({
        tools: {
          calls: 0,
          byTool: [
            { tool: 'edit', calls: 2 },
            { tool: 'read', calls: 1 },
          ],
        },
      }),
      chat({ tools: { calls: 0, byTool: [{ tool: 'edit', calls: 3 }] } }),
      chat({ tools: undefined }),
    ]
    expect(toolUsageEntries(chats)).toEqual([
      ['edit', 5],
      ['read', 1],
    ])
  })
})
