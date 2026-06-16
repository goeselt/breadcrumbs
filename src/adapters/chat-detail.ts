import type { AgentId } from '../agent.js'
import type { ChatDetailOptions, ChatDetailReport } from '../chat-detail.js'
import type { ChatMetadata } from '../chat-metadata.js'
import { providerAdapter } from './registry.js'

export interface ChatDetailSourceOverrides {
  copilotFile?: string
  codexRoot?: string
  claudeRoot?: string
}

export function readIndexedChatDetail(
  metadata: ChatMetadata,
  options: ChatDetailOptions = {},
): Promise<ChatDetailReport> {
  return providerAdapter(metadata.provider).readIndexedDetail(metadata, options)
}

export function readChatDetail(
  provider: AgentId,
  chatReference: string,
  options: ChatDetailOptions = {},
  sources: ChatDetailSourceOverrides = {},
): Promise<ChatDetailReport> {
  return providerAdapter(provider).readDetail(chatReference, options, sourceOverride(provider, sources))
}

function sourceOverride(provider: AgentId, sources: ChatDetailSourceOverrides): string | undefined {
  if (provider === 'copilot') return sources.copilotFile
  if (provider === 'codex') return sources.codexRoot
  return sources.claudeRoot
}
