import { describe, expect, it } from 'vitest'
import type { ChatMetadata } from '../chat-metadata.js'
import { buildRecentChatGroups, recentChatQuickPickLabel } from './recent-chats-model.js'

describe('recent chat navigation', () => {
  it('groups newest main chats, excludes child runs, and applies provider filters', () => {
    const chats = [
      fixtureChat('today', 'codex', '2026-06-15T08:00:00.000Z'),
      fixtureChat('yesterday', 'claude', '2026-06-14T08:00:00.000Z'),
      fixtureChat('week', 'codex', '2026-06-10T08:00:00.000Z'),
      { ...fixtureChat('child', 'claude', '2026-06-15T09:00:00.000Z'), kind: 'subagent' as const },
    ]

    const groups = buildRecentChatGroups(chats, new Date('2026-06-15T12:00:00.000Z'))
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday', 'Previous 7 Days'])
    expect(groups.flatMap((group) => group.chats).map((chat) => chat.providerChatId)).not.toContain('child')

    const codex = buildRecentChatGroups(chats, new Date('2026-06-15T12:00:00.000Z'), 'codex')
    expect(codex.flatMap((group) => group.chats).every((chat) => chat.provider === 'codex')).toBe(true)
  })

  it('creates searchable Quick Pick metadata', () => {
    const item = recentChatQuickPickLabel(fixtureChat('chat', 'codex', '2026-06-15T08:00:00.000Z'))
    expect(item.label).toBe('Chat chat')
    expect(item.description).toContain('Codex')
    expect(item.detail).toContain('workspace')
    expect(item.detail).toContain('model-a')
  })
})

function fixtureChat(id: string, provider: 'codex' | 'claude', startedAt: string): ChatMetadata {
  const tokens = {
    inputTokens: 10,
    cachedInputTokens: 2,
    cacheCreationInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 1,
    totalTokens: 13,
    totalTokenSemantics: 'fixture',
  }
  return {
    provider,
    chatKey: `${provider}:source:${id}`,
    providerChatId: id,
    chatId: id,
    sourceId: 'source',
    sourcePath: `/tmp/${id}.jsonl`,
    kind: 'main',
    title: `Chat ${id}`,
    startedAt,
    workspacePaths: ['/workspace'],
    requests: 1,
    models: [{ model: 'model-a', requests: 1, ...tokens }],
    tokens,
    billing: { status: 'unavailable' },
    providerMetadata: {},
    dataQuality: {
      confidence: 'high',
      deduplication: 'fixture',
      caveats: [],
    },
  }
}
