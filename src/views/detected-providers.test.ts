import { describe, expect, it } from 'vitest'
import type { DiscoveryReport } from '../discovery.js'
import type { ProviderReportResult } from '../webviews/report-html.js'
import { detectedProviderItems } from './detected-providers.js'

describe('detected provider sidebar items', () => {
  it('always includes every supported provider', () => {
    const discovery = fixtureDiscovery()
    const reports = new Map()

    expect(detectedProviderItems(discovery, reports)).toEqual([
      { provider: 'copilot', label: 'Copilot', description: 'Ready' },
      { provider: 'codex', label: 'Codex', description: 'Ready' },
      { provider: 'claude', label: 'Claude', description: 'Unavailable' },
    ])
  })

  it('uses indexed chat counts and includes indexed historical providers', () => {
    const discovery = fixtureDiscovery()
    const reports = new Map<'copilot' | 'codex' | 'claude', ProviderReportResult>([
      [
        'claude',
        {
          provider: 'claude',
          report: {
            totals: { chats: 12 },
          } as ProviderReportResult['report'],
        },
      ],
    ])

    expect(detectedProviderItems(discovery, reports)).toContainEqual({
      provider: 'claude',
      label: 'Claude',
      description: '12 chats',
    })
  })

  it('shows an in-flight provider as loading', () => {
    const reports = new Map<'copilot' | 'codex' | 'claude', ProviderReportResult>([
      ['codex', { provider: 'codex', loading: true }],
    ])

    expect(detectedProviderItems(fixtureDiscovery(), reports)).toContainEqual({
      provider: 'codex',
      label: 'Codex',
      description: 'Loading...',
    })
  })
})

function fixtureDiscovery(): DiscoveryReport {
  return {
    generatedAt: '2026-06-13T12:00:00.000Z',
    environment: {
      platform: 'linux',
      home: '~',
      workspaceTrusted: true,
    },
    workspaceFolders: [],
    agents: [
      provider('copilot', 'Copilot', true, false),
      provider('codex', 'Codex', false, true),
      provider('claude', 'Claude', false, false),
    ],
  }
}

function provider(
  id: 'copilot' | 'codex' | 'claude',
  label: string,
  installed: boolean,
  sourceExists: boolean,
): DiscoveryReport['agents'][number] {
  return {
    agent: {
      id,
      label,
      extensionIds: [],
      relevantSettings: [],
      expectedSources: [],
    },
    extensions: [{ id: `${id}.extension`, installed, active: installed }],
    settings: [],
    sources: [
      {
        agentId: id,
        label: `${label} source`,
        sourceKind: 'session-jsonl',
        sensitiveContentRisk: 'may-contain-content',
        probe: {
          path: `/tmp/${id}`,
          exists: sourceExists,
          kind: sourceExists ? 'directory' : 'missing',
        },
      },
    ],
    readiness: {
      configuration: { status: 'ready', findings: [] },
      source: {
        status: sourceExists ? 'available' : 'missing',
        paths: [`/tmp/${id}`],
      },
      analysis: {
        status: installed || sourceExists ? 'ready' : 'unavailable',
        reasons: [],
      },
    },
  }
}
