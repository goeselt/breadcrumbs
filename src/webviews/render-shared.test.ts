import { describe, expect, it } from 'vitest'
import type { ChatMetadata, TokenUsage } from '../chat-metadata.js'
import { cacheShare, tokenComponents, tokensByWorkspace } from './render-shared.js'

function tokens(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    totalTokenSemantics: 'distinct',
    ...overrides,
  }
}

function chat(workspace: string, totalTokens: number): ChatMetadata {
  return { workspacePaths: [workspace], tokens: tokens({ totalTokens }) } as unknown as ChatMetadata
}

describe('cacheShare', () => {
  it('uses input as the denominator when cached is a subset of input', () => {
    const semantics = 'cached_input_is_a_subset_of_input'
    expect(cacheShare(tokens({ inputTokens: 100, cachedInputTokens: 40, totalTokenSemantics: semantics }))).toBe(
      '40.0%',
    )
  })

  it('sums the input components when cached is reported separately', () => {
    expect(cacheShare(tokens({ inputTokens: 60, cachedInputTokens: 40, cacheCreationInputTokens: 0 }))).toBe('40.0%')
  })

  it('returns n/a when there is no input denominator', () => {
    expect(cacheShare(tokens())).toBe('n/a')
  })
})

describe('tokenComponents', () => {
  it('treats cached input as a subset for Codex (non-overlapping buckets)', () => {
    const { prompt, completion } = tokenComponents(
      'codex',
      tokens({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 }),
    )
    expect(prompt).toEqual([
      ['Uncached input', 6],
      ['Cached input', 4],
    ])
    expect(completion).toEqual([
      ['Output', 4],
      ['Reasoning', 2],
    ])
  })

  it('keeps cache read and creation separate for Claude', () => {
    const { prompt } = tokenComponents(
      'claude',
      tokens({ inputTokens: 10, cachedInputTokens: 4, cacheCreationInputTokens: 2 }),
    )
    expect(prompt).toEqual([
      ['Uncached input', 10],
      ['Cache read', 4],
      ['Cache creation', 2],
    ])
  })
})

describe('tokensByWorkspace', () => {
  it('sums tokens per workspace label, descending, capped to the limit', () => {
    const entries = tokensByWorkspace(
      [chat('/home/me/alpha', 100), chat('/home/me/beta', 50), chat('/home/me/alpha', 25), chat('/home/me/empty', 0)],
      2,
    )
    expect(entries).toEqual([
      ['alpha', 125],
      ['beta', 50],
    ])
  })
})
