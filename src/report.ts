import type { DiscoveryReport } from './discovery.js'

export function renderReport(report: DiscoveryReport): string {
  const lines: string[] = []
  lines.push(`Breadcrumbs discovery report`)
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push(
    `Extension host: remote=${report.environment.remoteName ?? 'local'}, platform=${report.environment.platform}, home=${report.environment.home}`,
  )
  lines.push(`Workspace trusted: ${report.environment.workspaceTrusted}`)
  lines.push(`Workspace folders: ${report.workspaceFolders.length > 0 ? report.workspaceFolders.join(', ') : '(none)'}`)
  lines.push('')

  for (const agent of report.agents) {
    lines.push(`${agent.agent.label}`)
    lines.push(
      `Readiness: analysis=${agent.readiness.analysis.status}, configuration=${agent.readiness.configuration.status}, source=${agent.readiness.source.status}`,
    )
    for (const finding of [...agent.readiness.configuration.findings, ...agent.readiness.analysis.reasons]) {
      lines.push(`- ${finding}`)
    }
    lines.push(`Extensions:`)
    for (const extension of agent.extensions) {
      const version = extension.version ? `@${extension.version}` : ''
      lines.push(
        `- ${extension.id}${version}: ${extension.installed ? 'installed' : 'missing'}, active=${extension.active}`,
      )
    }

    lines.push(`Settings:`)
    for (const setting of agent.settings) {
      lines.push(
        `- ${setting.id}: configured=${setting.configured}, restrictedIgnored=${setting.ignoredInRestrictedMode}, value=${formatValue(setting.value)}`,
      )
    }

    lines.push(`Sources:`)
    if (agent.sources.length === 0) {
      lines.push(`- none discovered yet`)
    } else {
      for (const source of agent.sources) {
        const size = source.probe.size === undefined ? '' : `, size=${source.probe.size}`
        lines.push(
          `- ${source.label}: ${source.probe.kind}, exists=${source.probe.exists}${size}, risk=${source.sensitiveContentRisk}`,
        )
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

function formatValue(value: unknown): string {
  if (value === undefined) return '(undefined)'
  if (typeof value === 'string') return value === '' ? '(empty)' : JSON.stringify(value)
  return JSON.stringify(value)
}
