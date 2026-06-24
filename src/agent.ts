export type AgentId = 'copilot' | 'codex' | 'claude'

export type DataSourceKind =
  | 'trace-database'
  | 'otel-jsonl'
  | 'debug-log'
  | 'session-jsonl'
  | 'extension-log'
  | 'unknown'

export interface AgentDefinition {
  id: AgentId
  label: string
  extensionIds: string[]
  relevantSettings: string[]
  expectedSources: DataSourceKind[]
}

export const AGENTS: AgentDefinition[] = [
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    extensionIds: ['GitHub.copilot-chat', 'github.copilot-chat'],
    relevantSettings: [
      'github.copilot.chat.otel.enabled',
      'github.copilot.chat.otel.exporterType',
      'github.copilot.chat.otel.outfile',
      'github.copilot.chat.otel.captureContent',
      'github.copilot.chat.otel.dbSpanExporter.enabled',
    ],
    expectedSources: ['trace-database', 'otel-jsonl', 'debug-log'],
  },
  {
    id: 'codex',
    label: 'Codex',
    extensionIds: ['openai.chatgpt'],
    relevantSettings: ['chatgpt.openOnStartup', 'chatgpt.cliExecutable', 'chatgpt.runCodexInWindowsSubsystemForLinux'],
    expectedSources: ['session-jsonl', 'extension-log'],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    extensionIds: ['Anthropic.claude-code', 'anthropic.claude-code'],
    relevantSettings: ['claudeCode.environmentVariables', 'claudeCode.useTerminal', 'claudeCode.claudeProcessWrapper'],
    expectedSources: ['session-jsonl', 'extension-log'],
  },
]

export function normalizeExtensionId(id: string): string {
  return id.toLowerCase()
}

export function matchesAgentExtension(agent: AgentDefinition, extensionId: string): boolean {
  const normalized = normalizeExtensionId(extensionId)
  return agent.extensionIds.some((id) => normalizeExtensionId(id) === normalized)
}
