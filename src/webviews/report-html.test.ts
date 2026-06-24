import { describe, expect, it } from 'vitest'
import type { ChatMetadataReport } from '../chat-metadata.js'
import type { DiscoveryReport } from '../discovery.js'
import { renderLoadingHtml, renderReportHtml } from './report-html.js'

describe('report Webview HTML', () => {
  it('uses a patient first-run loading message', () => {
    const html = renderLoadingHtml('Breadcrumbs', 'nonce-value')

    expect(html).toContain('loading the local usage index')
    expect(html).toContain('take a moment on the first run')
    expect(html).not.toContain('Index has not been loaded')
  })

  it('renders provider loading as a temporary state', () => {
    const html = renderReportHtml(
      'overview',
      {
        providers: [{ provider: 'codex', loading: true }],
      },
      'nonce-value',
    )

    expect(html).toContain('Loading')
    expect(html).toContain('Please wait a moment')
  })

  it('escapes metadata values and does not enable scripts in the chat list', () => {
    const report = fixtureReport()
    report.chats[0].providerChatId = '<script>alert("chat")</script>'
    report.chats[0].chatId = report.chats[0].providerChatId
    report.chats[0].workspacePaths = ['</td><script>alert("workspace")</script>']

    const html = renderReportHtml('chats', { providers: [{ provider: 'codex', report }] }, 'nonce-value')

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('alert("chat")')
    expect(html).not.toContain('alert("workspace")')
    expect(html).toContain('script&gt;')
    expect(html).toContain("default-src 'none'")
    // The chat list is a static view: no charts, so no inline scripts.
    expect(html).not.toContain('script-src')
  })

  it('neutralizes malicious metadata that flows into overview chart configs', () => {
    const report = fixtureReport()
    const payload = '</template><script>alert("xss")</script>'
    report.totals.models[0].model = payload
    report.chats[0].models[0].model = payload
    report.chats[0].workspacePaths = [`/repo/${payload}`]

    const html = renderReportHtml('overview', { providers: [{ provider: 'codex', report }], selectedProvider: 'codex' }, 'nonce-value')

    // Charts render, so the payload really does reach the chart-config templates.
    expect(html).toContain('model-token-chart')
    expect(html).toContain('overview-workspace-chart')
    // The payload must not break out of the <template> or inject an executable script.
    expect(html).not.toContain('</template><script>')
    expect(html).not.toContain('alert("xss")')
    // It survives only in the neutralized, JSON-escaped form.
    expect(html).toContain('\\u003c/template')
  })

  it('renders a provider-specific overview without a provider dropdown', () => {
    const report = fixtureReport()
    report.index = {
      storagePath: '~/.breadcrumbs/index',
      files: [
        {
          sourceId: 'source',
          sourcePath: '~/.codex/sessions/chat.jsonl',
          mode: 'stale',
          appendedRecords: 0,
          parserVersion: 2,
          sourceFormat: 'codex-session-jsonl',
          diagnostics: {
            recordsRead: 2,
            recordsUsed: 1,
            recordsIgnored: 0,
            invalidJsonLines: 0,
            unsupportedRecords: 0,
            partialLinePending: false,
            warnings: ['Synthetic warning'],
            confidence: 'low',
          },
          warning: 'Read failed',
        },
      ],
    }
    const html = renderReportHtml(
      'overview',
      {
        selectedProvider: 'codex',
        providers: [{ provider: 'codex', report }],
      },
      'nonce-value',
    )

    expect(html).toContain('cached_input_is_a_subset_of_input')
    expect(html).toContain('<h1>Codex</h1>')
    expect(html).toContain('Main chats')
    expect(html).toContain('Provider details')
    expect(html).toContain('Codex execution')
    expect(html).toContain('Reasoning share')
    expect(html).toContain('Index diagnostics')
    expect(html).toContain('codex-session-jsonl')
    expect(html).toContain('Synthetic warning')
    expect(html).not.toContain('provider-select')
    expect(html).toContain("script-src 'nonce-nonce-value'")
  })

  it('renders overview chart templates and inline Chart.js scripts', () => {
    const report = fixtureReport()
    report.totals.models[0].model = '</template><script>alert("model")</script>'
    report.chats[0].models[0].model = report.totals.models[0].model

    const html = renderReportHtml(
      'overview',
      {
        selectedProvider: 'codex',
        providers: [{ provider: 'codex', report }],
      },
      'nonce-value',
    )

    expect(html).toContain('class="chart-config"')
    expect(html).toContain('daily-tokens-chart')
    expect(html).toContain('daily-requests-chart')
    expect(html).toContain('model-token-chart')
    expect(html).toContain('\\u003c/template&gt;')
    expect(html).not.toContain('<script>alert("model")</script>')
    expect(html).toContain("script-src 'nonce-nonce-value'")
    expect(html).toContain('version="4.5.1"')
    expect(html).toContain('const module = undefined')
    expect(html).toContain('Chart.js did not initialize in this webview.')
    expect(html).toContain('new ChartCtor')
  })

  it('shows Copilot setup requirements and detected trace sources', () => {
    const report = fixtureReport()
    report.provider = 'copilot'
    report.chats[0].provider = 'copilot'
    const discovery: DiscoveryReport = {
      generatedAt: '2026-06-15T12:00:00.000Z',
      environment: {
        remoteName: 'wsl',
        platform: 'linux',
        home: '~',
        workspaceTrusted: true,
      },
      workspaceFolders: [],
      agents: [
        {
          agent: {
            id: 'copilot',
            label: 'GitHub Copilot Chat',
            extensionIds: ['GitHub.copilot-chat'],
            relevantSettings: [],
            expectedSources: ['trace-database'],
          },
          extensions: [],
          settings: [
            {
              id: 'github.copilot.chat.otel.dbSpanExporter.enabled',
              value: false,
              configured: false,
              ignoredInRestrictedMode: false,
            },
            {
              id: 'github.copilot.chat.otel.enabled',
              value: true,
              configured: true,
              ignoredInRestrictedMode: false,
            },
            {
              id: 'github.copilot.chat.otel.exporterType',
              value: 'file',
              configured: true,
              ignoredInRestrictedMode: false,
            },
            {
              id: 'github.copilot.chat.otel.captureContent',
              value: false,
              configured: true,
              ignoredInRestrictedMode: false,
            },
          ],
          sources: [
            {
              agentId: 'copilot',
              label: 'Copilot agent traces',
              sourceKind: 'trace-database',
              sensitiveContentRisk: 'may-contain-content',
              analysisSupported: true,
              probe: {
                path: '/home/user/agent-traces.db',
                exists: true,
                kind: 'file',
              },
            },
          ],
          readiness: {
            configuration: { status: 'ready', findings: [] },
            source: { status: 'available', paths: ['~/agent-traces.db'] },
            analysis: { status: 'ready', reasons: [] },
          },
        },
      ],
    }

    const html = renderReportHtml(
      'overview',
      {
        selectedProvider: 'copilot',
        providers: [{ provider: 'copilot', report }],
        discovery,
      },
      'nonce-value',
    )

    expect(html).toContain('Copilot data setup')
    expect(html).toContain('Structured agent traces')
    expect(html).toContain('Recommended setting missing')
    expect(html).toContain('&quot;github.copilot.chat.otel.dbSpanExporter.enabled&quot;: true')
    expect(html).toContain('Prompt and tool content')
    expect(html).toContain('Optional')
    expect(html).toContain('OTel JSONL fallback')
    expect(html).toContain('Open dbSpanExporter.enabled')
    expect(html).toContain('breadcrumbs.openCopilotSetting')
    expect(html).toContain('Remote Settings for the wsl extension host')
    expect(html).toContain('Remote [wsl]')
    expect(html).toContain('settings.json')
    expect(html).toContain('trace-database')
  })

  it('keeps Copilot setup visible when usage data is unavailable', () => {
    const discovery = {
      generatedAt: '2026-06-15T12:00:00.000Z',
      environment: { platform: 'linux' as const, home: '~', workspaceTrusted: true },
      workspaceFolders: [],
      agents: [
        {
          agent: {
            id: 'copilot' as const,
            label: 'GitHub Copilot Chat',
            extensionIds: ['GitHub.copilot-chat'],
            relevantSettings: [],
            expectedSources: ['trace-database' as const],
          },
          extensions: [],
          settings: [
            {
              id: 'github.copilot.chat.otel.dbSpanExporter.enabled',
              value: false,
              configured: false,
              ignoredInRestrictedMode: false,
            },
          ],
          sources: [],
          readiness: {
            configuration: { status: 'missing' as const, findings: ['Trace database disabled.'] },
            source: { status: 'missing' as const, paths: [] },
            analysis: { status: 'unavailable' as const, reasons: ['No source.'] },
          },
        },
      ],
    }
    const html = renderReportHtml(
      'overview',
      {
        selectedProvider: 'copilot',
        providers: [{ provider: 'copilot', error: 'No usage source.' }],
        discovery,
      },
      'nonce-value',
    )

    expect(html).toContain('No usage source.')
    expect(html).toContain('Copilot data setup')
    expect(html).toContain('Structured agent traces')
    expect(html).toContain('Recommended setting missing')
  })

  it('renders an all-provider overview with provider-scoped token totals', () => {
    const codex = fixtureReport()
    const claude = fixtureReport()
    claude.provider = 'claude'
    claude.chats[0].provider = 'claude'
    claude.totalsIncludingChildren = {
      ...claude.totals,
      tokens: {
        ...claude.totals.tokens,
        totalTokens: 21,
      },
    }

    const html = renderReportHtml(
      'overview',
      {
        providers: [
          { provider: 'codex', report: codex },
          { provider: 'claude', report: claude },
          { provider: 'copilot', error: 'Copilot data is unavailable.' },
        ],
      },
      'nonce-value',
    )

    expect(html).toContain('<h1>All Providers</h1>')
    expect(html).toContain('Available providers')
    expect(html).toContain('Provider usage')
    expect(html).toContain('Provider tokens')
    expect(html).toContain('Tokens incl. subagents')
    expect(html).toContain('Copilot data is unavailable.')
    expect(html).not.toContain('Total tokens</div>')
  })

  it('escapes provider model metadata and shows model proportions', () => {
    const report = fixtureReport()
    report.totals.models[0].model = '</script><script>alert("model")</script>'

    const html = renderReportHtml(
      'overview',
      {
        selectedProvider: 'codex',
        providers: [{ provider: 'codex', report }],
      },
      'nonce-value',
    )

    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert')
    expect(html).toContain('Request share')
    expect(html).toContain('Token share')
    expect(html).toContain('100.0%')
  })

  it('renders only the provider requested by the sidebar', () => {
    const codex = fixtureReport()
    const claude = fixtureReport()
    claude.provider = 'claude'

    const html = renderReportHtml(
      'overview',
      {
        selectedProvider: 'claude',
        providers: [
          { provider: 'codex', report: codex },
          { provider: 'claude', report: claude },
        ],
      },
      'nonce-value',
    )

    expect(html).toContain('<h1>Claude Code</h1>')
    expect(html).toContain('Claude activity')
    expect(html).not.toContain('Codex execution')
    expect(html).not.toContain('Providers')
  })

  it('renders Claude-specific child-run, cache, and server-tool signals', () => {
    const report = fixtureReport()
    report.provider = 'claude'
    report.chats[0].provider = 'claude'
    report.chats[0].kind = 'subagent'
    report.chats[0].providerMetadata = {
      serviceTiers: ['standard'],
      inferenceGeos: ['eu'],
      speeds: ['fast'],
      serverToolUse: {
        webFetchRequests: 2,
        webSearchRequests: 3,
      },
    }
    report.totalsIncludingChildren = {
      ...report.totals,
      tokens: { ...report.totals.tokens, totalTokens: 42 },
    }

    const html = renderReportHtml(
      'overview',
      {
        selectedProvider: 'claude',
        providers: [{ provider: 'claude', report }],
      },
      'nonce-value',
    )

    expect(html).toContain('Subagent runs')
    expect(html).toContain('Tokens including subagents')
    expect(html).toContain('Web search requests')
    expect(html).toContain('standard')
    expect(html).toContain('eu')
  })

  it('renders an all-chat inventory without a cross-provider token total', () => {
    const codex = fixtureReport()
    const longTitle = 'Investigate an unexpectedly large context window across several repeated model requests'
    codex.chats[0].title = longTitle
    codex.chats.push({
      ...codex.chats[0],
      chatKey: 'codex:source:empty',
      providerChatId: 'empty',
      chatId: 'empty',
      title: 'Empty chat must not render',
      requests: 0,
    })
    const claude = fixtureReport()
    claude.provider = 'claude'
    claude.chats[0].provider = 'claude'
    claude.chats[0].chatKey = 'claude:source:chat'

    const html = renderReportHtml(
      'chats',
      {
        providers: [
          { provider: 'codex', report: codex },
          { provider: 'claude', report: claude },
        ],
      },
      'nonce-value',
    )

    expect(html).toContain('<h1>All Chats</h1>')
    expect(html).toContain('Providers')
    expect(html).not.toContain('Provider share')
    expect(html).not.toContain('Total tokens</div>')
    expect(html).not.toContain('command:breadcrumbs.openChatDetail?')
    expect(html).toContain('class="chat-list"')
    expect(html).toContain('class="chat-entry"')
    expect(html).toContain('class="chat-entry-title"')
    expect(html).toContain('class="chat-field-value number"')
    expect(html).not.toContain('class="chat-table')
    expect(html).toContain(`title="${longTitle}"`)
    expect(html).toContain(longTitle)
    expect(html).not.toContain('Empty chat must not render')
  })

  it('orders chat entries newest first', () => {
    const report = fixtureReport()
    const olderChat = {
      ...report.chats[0],
      title: 'Older chat',
      startedAt: '2026-06-13T12:00:00.000Z',
    }
    const newerChat = {
      ...report.chats[0],
      chatKey: 'codex:source:newer',
      providerChatId: 'newer',
      chatId: 'newer',
      title: 'Newest chat',
      startedAt: '2026-06-14T12:00:00.000Z',
    }
    report.chats = [olderChat, newerChat]

    const html = renderReportHtml('chats', { providers: [{ provider: 'codex', report }] }, 'nonce-value')

    expect(html.indexOf('Newest chat')).toBeLessThan(html.indexOf('Older chat'))
  })

  it('renders an explicit validated chat-detail action when navigation is enabled', () => {
    const report = fixtureReport()
    const html = renderReportHtml(
      'chats',
      {
        providers: [{ provider: 'codex', report }],
        chatDetailNavigation: 'command',
      },
      'nonce-value',
    )

    expect(html).toContain('class="chat-entry-action"')
    expect(html).toContain('>Details</a>')
    expect(html).toContain('command:breadcrumbs.openChatDetail?')
    expect(html).toContain(encodeURIComponent(report.chats[0].chatKey))
    expect(html).not.toContain('<a class="chat-entry-title"')
  })

  it('uses VS Code theme colors for modern list states', () => {
    const html = renderReportHtml(
      'chats',
      { providers: [{ provider: 'codex', report: fixtureReport() }] },
      'nonce-value',
    )

    expect(html).toContain('border-radius: 6px')
    expect(html).toContain('var(--vscode-list-hoverBackground)')
    expect(html).toContain('grid-template-columns: repeat(auto-fit, minmax(105px, 1fr))')
    expect(html).toContain('.chat-entry:hover')
    expect(html).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('renders provider-specific chat columns and excludes other providers', () => {
    const codex = fixtureReport()
    const claude = fixtureReport()
    claude.provider = 'claude'
    claude.chats[0].provider = 'claude'
    claude.chats[0].chatKey = 'claude:source:chat'

    const html = renderReportHtml(
      'chats',
      {
        selectedProvider: 'codex',
        providers: [
          { provider: 'codex', report: codex },
          { provider: 'claude', report: claude },
        ],
      },
      'nonce-value',
    )

    expect(html).toContain('<h1>Codex Chats</h1>')
    expect(html).toContain('Reasoning share')
    expect(html).toContain('Context window')
    expect(html).toContain('Average TTFT')
    expect(html).toContain('Provider share')
    expect(html).not.toContain('Cache creation')
    expect(html).not.toContain('claude%3Asource%3Achat')
  })

  it('renders metadata-only chat detail without emitting captured content', () => {
    const metadata = fixtureReport().chats[0]
    const html = renderReportHtml(
      'chatDetail',
      {
        selectedProvider: 'codex',
        selectedChatKey: metadata.chatKey,
        providers: [],
        chatDetailNavigation: 'command',
        chatDetailContentEnabled: false,
        chatDetail: {
          schemaVersion: 2,
          reportType: 'chat-detail',
          provider: 'codex',
          chatKey: metadata.chatKey,
          providerChatId: metadata.providerChatId,
          chatId: metadata.chatId,
          generatedAt: '2026-06-13T12:00:00.000Z',
          found: true,
          source: {
            path: metadata.sourcePath,
            recordsRead: 2,
            invalidRecords: 0,
          },
          privacy: {
            contentMode: 'none',
            contentEmitted: false,
            maxContentCharsPerField: 1000,
            warning: 'Content is suppressed.',
          },
          metadata,
          summary: {
            timelineEvents: 4,
            emittedTimelineEvents: 4,
            omittedTimelineEvents: 0,
            contextEntries: 1,
            eventKinds: {
              user_message: 1,
              assistant_message: 1,
              tool_call: 1,
              tool_result: 1,
            },
            contentCharsObserved: 170,
            contentCharsEmitted: 0,
          },
          context: [
            {
              kind: 'developer_instructions',
              label: 'Instructions',
              source: 'fixture',
              content: {
                originalChars: 12,
                emittedChars: 0,
                truncated: false,
                text: 'secret-value',
              },
            },
          ],
          timeline: [
            {
              kind: 'user_message',
              timestamp: '2026-06-13T12:00:00.000Z',
              content: {
                originalChars: 12,
                emittedChars: 0,
                truncated: false,
                text: 'secret-value',
              },
            },
            {
              kind: 'assistant_message',
              timestamp: '2026-06-13T12:00:00.500Z',
              content: {
                originalChars: 158,
                emittedChars: 0,
                truncated: false,
              },
            },
            {
              kind: 'tool_call',
              timestamp: '2026-06-13T12:00:01.000Z',
              toolName: 'Agent',
              toolCallId: 'tool-agent',
              details: {
                subagentType: 'Explore',
              },
            },
            {
              kind: 'tool_result',
              timestamp: '2026-06-13T12:00:02.000Z',
              toolCallId: 'tool-agent',
              details: {
                agentId: 'agent-123',
                agentType: 'Explore',
                totalTokens: 3400,
              },
            },
          ],
        },
      },
      'nonce-value',
    )

    expect(html).toContain('<h1>Codex Chat</h1>')
    expect(html).toContain('Captured content is disabled while VS Code is in Restricted Mode.')
    expect(html).not.toContain('Export metadata JSON')
    expect(html).not.toContain('command:breadcrumbs.exportMetadataJson?')
    expect(html).toContain('Chat snapshot')
    expect(html).toContain('captured 2026-06-13')
    expect(html).toContain('Background changes do not replace this view.')
    expect(html).toContain('Refresh snapshot')
    expect(html).toContain('command:breadcrumbs.refreshChatSnapshot?')
    expect(html).toContain('Context structure')
    expect(html).toContain('Timeline')
    expect(html).not.toContain('Provider signals')
    expect(html).toContain('Token composition')
    expect(html).toContain('prompt-composition-chart')
    expect(html).toContain('completion-composition-chart')
    expect(html).toContain('model-composition-chart')
    expect(html).not.toContain('Observations')
    expect(html).toContain('class="detail-list"')
    expect(html).not.toContain('<table')
    expect(html).toContain('User input 1')
    expect(html).toContain('<details class="timeline-chain" open>')
    expect(html).toContain('<summary class="timeline-chain-header">')
    expect(html).toContain('<details class="timeline-tree-node subagent" open>')
    expect(html).toContain('<details class="timeline-tree-node subagent">')
    expect(html).toContain('class="timeline-tree-children"')
    expect(html).toContain('<summary class="timeline-node-summary">')
    expect(html).toContain('class="timeline-tree-node timeline-tree-leaf agent"')
    expect(html).toContain('Agent response &middot; 158 chars hidden')
    expect(html).not.toContain(
      '<summary class="timeline-node-summary"><span class="timeline-node-title">Agent response',
    )
    expect(html).toContain('Agent delegates work to a subagent')
    expect(html).toContain('Result returned by delegated agent')
    expect(html).toContain('Agent tokens')
    expect(html).toContain('12 chars hidden')
    expect(html).not.toContain('secret-value')
  })

  it('renders explicitly selected tool commands and outputs', () => {
    const metadata = fixtureReport().chats[0]
    const html = renderReportHtml(
      'chatDetail',
      {
        selectedProvider: 'codex',
        selectedChatKey: metadata.chatKey,
        providers: [],
        chatDetailNavigation: 'command',
        chatDetail: {
          schemaVersion: 2,
          reportType: 'chat-detail',
          provider: 'codex',
          chatKey: metadata.chatKey,
          providerChatId: metadata.providerChatId,
          chatId: metadata.chatId,
          generatedAt: '2026-06-15T06:00:00.000Z',
          found: true,
          source: {
            path: metadata.sourcePath,
            recordsRead: 2,
            invalidRecords: 0,
          },
          privacy: {
            contentMode: 'tools',
            contentEmitted: true,
            maxContentCharsPerField: 2_000,
            warning: 'Tool content can be sensitive.',
          },
          metadata,
          summary: {
            timelineEvents: 2,
            emittedTimelineEvents: 2,
            omittedTimelineEvents: 0,
            contextEntries: 0,
            eventKinds: { tool_call: 1, tool_result: 1 },
            contentCharsObserved: 120,
            contentCharsEmitted: 120,
          },
          context: [],
          timeline: [
            {
              kind: 'tool_call',
              timestamp: '2026-06-15T06:00:00.000Z',
              toolName: 'exec_command',
              toolCallId: 'call-test',
              content: {
                originalChars: 45,
                emittedChars: 45,
                truncated: false,
                text: '{"cmd":"printf \\"<sensitive>\\"","workdir":"/repo"}',
              },
              details: { argumentKeys: ['cmd', 'workdir'] },
            },
            {
              kind: 'tool_result',
              timestamp: '2026-06-15T06:00:01.000Z',
              toolCallId: 'call-test',
              content: {
                originalChars: 21,
                emittedChars: 21,
                truncated: false,
                text: 'Output:\n<sensitive>',
              },
              details: {
                exitCode: 0,
                originalTokenCount: 3,
                chunkId: 'chunk-test',
              },
            },
          ],
        },
      },
      'nonce-value',
    )

    expect(html).not.toContain('aria-current')
    expect(html).not.toContain('Export metadata JSON')
    expect(html).toContain('Arguments / command')
    expect(html).toContain('printf &quot;&lt;sensitive&gt;&quot;')
    expect(html).toContain('Output:')
    expect(html).toContain('&lt;sensitive&gt;')
    expect(html).toContain('Exit 0')
    expect(html).toContain('3 output tokens')
    expect(html).toContain('chunk-test')
    // Captured content must not inject a raw (nonce-less) script tag; chart scripts carry a nonce.
    expect(html).not.toContain('<script>')
  })

  it('renders conversation, reasoning, context, and tool excerpts in all-details mode', () => {
    const metadata = fixtureReport().chats[0]
    const html = renderReportHtml(
      'chatDetail',
      {
        selectedProvider: 'codex',
        selectedChatKey: metadata.chatKey,
        providers: [],
        chatDetailNavigation: 'command',
        chatDetail: {
          schemaVersion: 2,
          reportType: 'chat-detail',
          provider: 'codex',
          chatKey: metadata.chatKey,
          providerChatId: metadata.providerChatId,
          chatId: metadata.chatId,
          generatedAt: '2026-06-15T06:00:00.000Z',
          found: true,
          privacy: {
            contentMode: 'all',
            contentEmitted: true,
            maxContentCharsPerField: 2_000,
            warning: 'Captured details can contain sensitive local data.',
          },
          metadata,
          summary: {
            timelineEvents: 6,
            emittedTimelineEvents: 6,
            omittedTimelineEvents: 0,
            contextEntries: 1,
            eventKinds: {
              user_message: 1,
              assistant_message: 1,
              reasoning: 1,
              tool_call: 1,
              model_request: 2,
            },
            contentCharsObserved: 81,
            contentCharsEmitted: 81,
          },
          context: [
            {
              kind: 'developer_instructions',
              label: 'Developer instructions',
              source: 'fixture',
              content: {
                originalChars: 16,
                emittedChars: 16,
                truncated: false,
                text: 'Inspect the tests',
              },
            },
          ],
          timeline: [
            {
              kind: 'user_message',
              timestamp: '2026-06-15T06:00:00.000Z',
              content: {
                originalChars: 22,
                emittedChars: 22,
                truncated: false,
                text: 'Explain <this> failure',
              },
            },
            {
              kind: 'assistant_message',
              timestamp: '2026-06-15T06:00:01.000Z',
              content: {
                originalChars: 17,
                emittedChars: 17,
                truncated: false,
                text: 'I found the cause.',
              },
            },
            {
              kind: 'reasoning',
              timestamp: '2026-06-15T06:00:02.000Z',
              content: {
                originalChars: 14,
                emittedChars: 14,
                truncated: false,
                text: 'Check call IDs',
              },
            },
            {
              kind: 'model_request',
              timestamp: '2026-06-15T06:00:02.250Z',
              model: 'model-a',
              usage: {
                inputTokens: 8_000,
                cachedInputTokens: 1_500,
                cacheCreationInputTokens: 500,
                outputTokens: 500,
                reasoningOutputTokens: 100,
                totalTokens: 10_500,
                totalTokenSemantics: 'input_plus_cache_creation_plus_cache_read_plus_output',
              },
            },
            {
              kind: 'model_request',
              timestamp: '2026-06-15T06:00:02.500Z',
              model: 'model-a',
              usage: {
                inputTokens: 6_000,
                cachedInputTokens: 1_000,
                cacheCreationInputTokens: 500,
                outputTokens: 400,
                reasoningOutputTokens: 80,
                totalTokens: 7_900,
                totalTokenSemantics: 'input_plus_cache_creation_plus_cache_read_plus_output',
              },
            },
            {
              kind: 'tool_call',
              timestamp: '2026-06-15T06:00:03.000Z',
              toolName: 'exec_command',
              content: {
                originalChars: 12,
                emittedChars: 12,
                truncated: false,
                text: 'npm test',
              },
            },
          ],
        },
      },
      'nonce-value',
    )

    expect(html).not.toContain('detail-control active')
    expect(html).toContain('User message')
    expect(html).toContain('Explain &lt;this&gt; failure')
    expect(html).toContain('Agent response')
    expect(html).toContain('I found the cause.')
    expect(html).toContain('Reasoning summary')
    expect(html).toContain('Check call IDs')
    expect(html).toContain('Captured context')
    expect(html).toContain('Inspect the tests')
    expect(html).toContain('Arguments / command')
    expect(html).toContain('npm test')
    expect(html).not.toContain('Context development')
    expect(html).toContain('Request tokens 10,500')
    expect(html).toContain('Cumulative tokens 10,500')
    expect(html).toContain('Request tokens 7,900')
    expect(html).toContain('Cumulative tokens 18,400')
    expect(html).toContain('2026-06-15')
    expect(html).toContain('class="timeline-timestamp"')
    expect(html).toContain('class="timeline-node-meta"')
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
    generatedAt: '2026-06-13T12:00:00.000Z',
    source: {
      path: '~/.codex/sessions',
      exists: true,
      filesRead: 1,
      recordsRead: 2,
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
        startedAt: '2026-06-13T12:00:00.000Z',
        endedAt: '2026-06-13T12:00:01.000Z',
        wallClockDurationMs: 1000,
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
