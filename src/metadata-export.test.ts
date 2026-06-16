import { describe, expect, it } from 'vitest'
import type { ChatMetadataReport } from './chat-metadata.js'
import { createMetadataExport, metadataExportFileName } from './metadata-export.js'

describe('metadata export', () => {
  it('creates a versioned all-provider export', () => {
    const report = fixtureReport()
    const exported = createMetadataExport([
      { provider: 'codex', report },
      { provider: 'claude', error: 'Source unavailable' },
    ])

    expect(exported).toMatchObject({
      schemaVersion: 1,
      reportType: 'breadcrumbs-metadata-export',
      scope: 'all-providers',
    })
    expect(exported.providers).toHaveLength(2)
    expect(JSON.stringify(exported)).not.toContain('capturedContent')
  })

  it('exports exactly one selected chat with source provenance', () => {
    const report = fixtureReport()
    const exported = createMetadataExport([{ provider: 'codex', report }], {
      provider: 'codex',
      chatKey: report.chats[0].chatKey,
    })

    expect(exported).toMatchObject({
      scope: 'chat',
      chat: {
        provider: 'codex',
        source: { path: '~/.codex/sessions' },
        metadata: { chatKey: 'codex:source:chat' },
      },
    })
    expect(exported.providers).toBeUndefined()
  })

  it('uses filesystem-safe timestamped names', () => {
    expect(metadataExportFileName()).toMatch(/^breadcrumbs-metadata-.*Z\.json$/)
    expect(metadataExportFileName()).not.toContain(':')
  })
})

function fixtureReport(): ChatMetadataReport {
  const tokens = {
    inputTokens: 10,
    cachedInputTokens: 2,
    cacheCreationInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 1,
    totalTokens: 13,
    totalTokenSemantics: 'input_plus_output; cached_input_is_a_subset_of_input',
  }
  return {
    schemaVersion: 2,
    reportType: 'chat-metadata-list',
    provider: 'codex',
    generatedAt: '2026-06-15T00:00:00.000Z',
    source: {
      path: '~/.codex/sessions',
      exists: true,
      filesRead: 1,
      recordsRead: 3,
      invalidRecords: 0,
    },
    privacy: {
      contentReadDuringParsing: true,
      contentEmitted: false,
      note: 'metadata only',
    },
    totals: {
      chats: 1,
      requests: 1,
      wallClockDurationMs: 1000,
      tokens,
      models: [{ model: 'model-a', requests: 1, ...tokens }],
    },
    chats: [
      {
        provider: 'codex',
        chatKey: 'codex:source:chat',
        providerChatId: 'chat',
        chatId: 'chat',
        sourceId: 'source',
        sourcePath: '~/.codex/sessions/chat.jsonl',
        kind: 'main',
        startedAt: '2026-06-15T00:00:00.000Z',
        workspacePaths: ['~/workspace'],
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
      },
    ],
  }
}
