import { describe, expect, it } from 'vitest'
import { AGENTS, matchesAgentExtension, normalizeExtensionId } from './agent.js'

describe('agent definitions', () => {
  it('normalizes extension IDs case-insensitively', () => {
    expect(normalizeExtensionId('Anthropic.claude-code')).toBe('anthropic.claude-code')
  })

  it('matches known agent extension IDs', () => {
    const claude = AGENTS.find((agent) => agent.id === 'claude')
    expect(claude).toBeDefined()
    expect(matchesAgentExtension(claude!, 'anthropic.claude-code')).toBe(true)
    expect(matchesAgentExtension(claude!, 'openai.chatgpt')).toBe(false)
  })
})
