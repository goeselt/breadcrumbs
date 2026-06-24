import REPORT_CSS from './report.css?inline'
import CHART_JS from '../../resources/vendor/chart.umd.min.js?inline'
import { renderChatDetail } from './render-chat-detail.js'
import { renderChats } from './render-chats.js'
import { renderOverview } from './render-overview.js'
import { renderSources } from './render-sources.js'
import { providerChatDetailTitle, providerChatsTitle, providerLabel, escapeHtml } from './render-primitives.js'
import type { ReportViewData } from './types.js'
import type { ReportViewKind } from '../views/report-tree.js'

export type { ProviderReportResult, ReportViewData } from './types.js'

export function renderReportHtml(kind: ReportViewKind, data: ReportViewData, nonce: string): string {
  const title =
    kind === 'overview'
      ? data.selectedProvider
        ? providerLabel(data.selectedProvider)
        : 'All Providers'
      : kind === 'chats'
        ? data.selectedProvider
          ? providerChatsTitle(data.selectedProvider)
          : 'All Chats'
        : kind === 'chatDetail'
          ? data.selectedProvider
            ? providerChatDetailTitle(data.selectedProvider)
            : 'Chat Detail'
          : 'Sources'
  const body =
    kind === 'overview'
      ? renderOverview(data.providers, data.selectedProvider, data.discovery)
      : kind === 'chats'
        ? renderChats(data.providers, data.selectedProvider, data.chatDetailNavigation ?? 'none')
        : kind === 'chatDetail'
          ? renderChatDetail(
              data.chatDetail,
              data.chatDetailNavigation ?? 'none',
              data.chatDetailContentEnabled ?? true,
            )
          : renderSources(data.discovery)
  const hasCharts = body.includes('class="chart-config"')
  const scriptPolicy = hasCharts ? ` script-src 'nonce-${nonce}';` : ''
  const chartScripts = hasCharts
    ? `
  <script nonce="${nonce}">${chartLibraryScript()}</script>
  <script nonce="${nonce}">${chartBootstrapScript()}</script>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';${scriptPolicy}">
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">${REPORT_CSS}</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </main>
  ${chartScripts}
</body>
</html>`
}

function chartLibraryScript(): string {
  return `(() => {
  const module = undefined;
  const exports = undefined;
  const define = undefined;
  ${CHART_JS}
})();`
}

function chartBootstrapScript(): string {
  return `(() => {
  const ChartCtor = window.Chart;
  if (!ChartCtor) {
    showChartError('Chart.js did not initialize in this webview.');
    return;
  }
  const styles = getComputedStyle(document.body);
  const foreground = styles.getPropertyValue('--vscode-foreground').trim() || '#d4d4d4';
  const muted = styles.getPropertyValue('--vscode-descriptionForeground').trim() || foreground;
  const grid = styles.getPropertyValue('--vscode-widget-border').trim()
    || styles.getPropertyValue('--vscode-panel-border').trim()
    || 'rgba(127, 127, 127, 0.35)';
  ChartCtor.defaults.color = foreground;
  ChartCtor.defaults.borderColor = grid;
  ChartCtor.defaults.font.family = styles.getPropertyValue('--vscode-font-family').trim() || undefined;
  for (const template of document.querySelectorAll('.chart-config')) {
    const target = document.getElementById(template.dataset.chartTarget || '');
    if (!(target instanceof HTMLCanvasElement)) continue;
    try {
      const config = JSON.parse(template.content.textContent || '{}');
      config.options = withChartDefaults(config.options || {}, muted, grid);
      new ChartCtor(target, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      target.replaceWith(chartErrorElement('Chart data could not be rendered: ' + message));
    }
  }

  function showChartError(message) {
    for (const canvas of document.querySelectorAll('[data-chart]')) {
      if (canvas instanceof HTMLCanvasElement) {
        canvas.replaceWith(chartErrorElement(message));
      }
    }
  }

  function chartErrorElement(message) {
    const element = document.createElement('div');
    element.className = 'chart-error';
    element.textContent = message;
    return element;
  }

  function withChartDefaults(options, mutedColor, gridColor) {
    const merged = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      ...options,
      plugins: {
        legend: {
          labels: {
            boxWidth: 12,
            color: mutedColor,
          },
        },
        tooltip: {},
        ...(options.plugins || {}),
      },
    };
    if (merged.scales) {
      for (const scale of Object.values(merged.scales)) {
        scale.grid = { color: gridColor, ...(scale.grid || {}) };
        scale.ticks = { color: mutedColor, ...(scale.ticks || {}) };
        scale.title = { color: mutedColor, ...(scale.title || {}) };
      }
      // Pin every y-axis to a fixed width so stacked time charts share an identical day scale.
      if (typeof merged.matchAxisWidth === 'number') {
        const fixed = merged.matchAxisWidth;
        for (const scale of Object.values(merged.scales)) {
          scale.afterFit = (axis) => {
            axis.width = fixed;
          };
        }
      }
    }
    return merged;
  }
})();`
}

export function renderLoadingHtml(title: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';"><style nonce="${nonce}">body{padding:24px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}p{color:var(--vscode-descriptionForeground)}</style><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>Breadcrumbs is loading the local usage index. This can take a moment on the first run.</p></body></html>`
}

export function renderErrorHtml(title: string, error: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';"><style nonce="${nonce}">body{padding:24px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}p{color:var(--vscode-errorForeground);white-space:pre-wrap}</style><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(error)}</p></body></html>`
}
