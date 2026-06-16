import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMetadata, ChatMetadataReport } from '../chat-metadata.js'
import { readClaudeChatMetadata } from './claude.js'
import { readCodexChatMetadata } from './codex.js'
import { readCopilotChatMetadata } from './copilot.js'

const fixturesRoot = path.join(process.cwd(), 'fixtures/golden')

describe('provider golden fixtures', () => {
  it.each([
    {
      provider: 'copilot',
      read: () => readCopilotChatMetadata(path.join(fixturesRoot, 'copilot/session.jsonl')),
    },
    {
      provider: 'codex',
      read: () => readCodexChatMetadata(path.join(fixturesRoot, 'codex/sessions')),
    },
    {
      provider: 'claude',
      read: () => readClaudeChatMetadata(path.join(fixturesRoot, 'claude')),
    },
  ])('normalizes the $provider fixture to its committed expectation', async ({ provider, read }) => {
    const report = await read()
    const expected = JSON.parse(await readFile(path.join(fixturesRoot, provider, 'expected.json'), 'utf8')) as unknown

    expect(summarizeReport(report)).toEqual(expected)
  })
})

function summarizeReport(report: ChatMetadataReport) {
  return {
    provider: report.provider,
    chats: report.chats.map(summarizeChat),
  }
}

function summarizeChat(chat: ChatMetadata) {
  return {
    providerChatId: chat.providerChatId,
    ...(chat.title ? { title: chat.title } : {}),
    startedAt: chat.startedAt,
    endedAt: chat.endedAt,
    requests: chat.requests,
    tokens: {
      inputTokens: chat.tokens.inputTokens,
      cachedInputTokens: chat.tokens.cachedInputTokens,
      cacheCreationInputTokens: chat.tokens.cacheCreationInputTokens,
      outputTokens: chat.tokens.outputTokens,
      reasoningOutputTokens: chat.tokens.reasoningOutputTokens,
      totalTokens: chat.tokens.totalTokens,
    },
    models: chat.models.map((model) => ({
      model: model.model,
      requests: model.requests,
      totalTokens: model.totalTokens,
    })),
  }
}
