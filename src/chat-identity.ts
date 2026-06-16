import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AgentId } from './agent.js'

export type ChatKind = 'main' | 'subagent'

export interface ChatIdentity {
  chatKey: string
  providerChatId: string
  sourceId: string
  kind: ChatKind
  parentChatKey?: string
}

export function sourceIdForPath(sourcePath: string): string {
  const canonicalPath = path.normalize(path.resolve(sourcePath))
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16)
}

export function chatKeyFor(provider: AgentId, providerChatId: string, sourcePath: string): string {
  return `${provider}:${sourceIdForPath(sourcePath)}:${encodeURIComponent(providerChatId)}`
}

export function mainChatIdentity(provider: AgentId, providerChatId: string, sourcePath: string): ChatIdentity {
  return {
    chatKey: chatKeyFor(provider, providerChatId, sourcePath),
    providerChatId,
    sourceId: sourceIdForPath(sourcePath),
    kind: 'main',
  }
}

export function claudeChatIdentity(providerChatId: string, sourcePath: string): ChatIdentity {
  const subagentMarker = `${path.sep}subagents${path.sep}`
  if (!sourcePath.includes(subagentMarker)) return mainChatIdentity('claude', providerChatId, sourcePath)

  const sessionDirectory = path.dirname(path.dirname(sourcePath))
  const parentSourcePath = `${sessionDirectory}.jsonl`
  return {
    chatKey: chatKeyFor('claude', providerChatId, sourcePath),
    providerChatId,
    sourceId: sourceIdForPath(sourcePath),
    kind: 'subagent',
    parentChatKey: chatKeyFor('claude', providerChatId, parentSourcePath),
  }
}
