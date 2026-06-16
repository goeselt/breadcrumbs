import type { DiscoveryReport } from '../discovery.js'
import { escapeHtml, metric } from './render-primitives.js'

export function renderSources(discovery: DiscoveryReport | undefined): string {
  if (!discovery) return '<div class="empty">Source discovery is unavailable.</div>'
  const rows = discovery.agents
    .map((agent) => {
      const extensions = agent.extensions
        .map(
          (extension) =>
            `${extension.id}${extension.version ? `@${extension.version}` : ''} (${extension.installed ? (extension.active ? 'active' : 'inactive') : 'missing'})`,
        )
        .join(', ')
      return `<tr>
        <td class="provider">${escapeHtml(agent.agent.label)}</td>
        <td><span class="status ${escapeHtml(agent.readiness.analysis.status)}">${escapeHtml(agent.readiness.analysis.status)}</span></td>
        <td><span class="status ${escapeHtml(agent.readiness.configuration.status)}">${escapeHtml(agent.readiness.configuration.status)}</span></td>
        <td><span class="status ${escapeHtml(agent.readiness.source.status)}">${escapeHtml(agent.readiness.source.status)}</span></td>
        <td class="wrap">${escapeHtml(extensions)}</td>
        <td class="wrap">${agent.readiness.source.paths.map((source) => `<code>${escapeHtml(source)}</code>`).join('<br>')}</td>
        <td class="wrap">${escapeHtml([...agent.readiness.configuration.findings, ...agent.readiness.analysis.reasons].join(' ') || '(none)')}</td>
      </tr>`
    })
    .join('')

  return `<div class="summary">
    ${metric('Extension host', discovery.environment.remoteName ?? 'local')}
    ${metric('Platform', discovery.environment.platform)}
    ${metric('Workspace trust', discovery.environment.workspaceTrusted ? 'Trusted' : 'Restricted')}
    ${metric('Home', discovery.environment.home)}
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>Provider</th><th>Analysis</th><th>Configuration</th><th>Source</th><th>Extensions</th><th>Paths</th><th>Findings</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}
