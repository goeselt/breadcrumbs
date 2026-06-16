import { describe, expect, it } from 'vitest'
import { renderReport } from './report.js'
import type { DiscoveryReport } from './discovery.js'

describe('renderReport', () => {
  it('renders agent status without reading sensitive content', () => {
    const report: DiscoveryReport = {
      generatedAt: '2026-06-12T12:00:00.000Z',
      environment: {
        remoteName: 'wsl',
        platform: 'linux',
        home: '~',
        workspaceTrusted: true,
      },
      workspaceFolders: ['/repo'],
      agents: [
        {
          agent: {
            id: 'codex',
            label: 'Codex',
            extensionIds: ['openai.chatgpt'],
            relevantSettings: [],
            expectedSources: ['session-jsonl'],
          },
          extensions: [{ id: 'openai.chatgpt', installed: true, active: false, version: '1.2.3' }],
          settings: [
            {
              id: 'chatgpt.openOnStartup',
              value: false,
              configured: true,
              ignoredInRestrictedMode: false,
            },
          ],
          sources: [
            {
              agentId: 'codex',
              label: 'Codex sessions',
              sourceKind: 'session-jsonl',
              sensitiveContentRisk: 'may-contain-content',
              probe: { path: '/home/user/.codex/sessions', exists: true, kind: 'directory' },
            },
          ],
          readiness: {
            configuration: { status: 'ready', findings: [] },
            source: { status: 'available', paths: ['~/.codex/sessions'] },
            analysis: { status: 'ready', reasons: [] },
          },
        },
      ],
    }

    expect(renderReport(report)).toContain('openai.chatgpt@1.2.3')
    expect(renderReport(report)).toContain('risk=may-contain-content')
    expect(renderReport(report)).toContain('remote=wsl')
    expect(renderReport(report)).toContain('analysis=ready')
  })
})
