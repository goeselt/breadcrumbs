import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

interface ExtensionManifest {
  activationEvents?: string[]
  contributes?: {
    viewsContainers?: {
      activitybar?: Array<{ id?: string; title?: string; icon?: string }>
    }
    views?: Record<string, Array<{ id?: string; name?: string; icon?: string }>>
    viewsWelcome?: Array<{ view?: string; contents?: string; when?: string }>
    commands?: Array<{ command?: string; title?: string }>
  }
}

describe('extension manifest', () => {
  it('registers the Breadcrumbs Activity Bar container and its view', async () => {
    const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as ExtensionManifest

    expect(manifest.contributes?.viewsContainers?.activitybar).toContainEqual({
      id: 'breadcrumbs',
      title: 'Breadcrumbs',
      icon: 'resources/breadcrumbs.svg',
    })
    expect(manifest.contributes?.views?.breadcrumbs).toContainEqual({
      id: 'breadcrumbs.reports',
      name: 'Reports',
      icon: 'resources/breadcrumbs.svg',
    })
    expect(manifest.contributes?.views?.breadcrumbs).toContainEqual({
      id: 'breadcrumbs.recentChats',
      name: 'Recent Chats',
      icon: 'resources/breadcrumbs.svg',
    })
    expect(manifest.contributes?.views?.breadcrumbs).toContainEqual({
      id: 'breadcrumbs.sources',
      name: 'Sources',
      icon: 'resources/breadcrumbs.svg',
    })
    expect(manifest.contributes?.viewsWelcome).toContainEqual(
      expect.objectContaining({ view: 'breadcrumbs.recentChats' }),
    )
    expect(manifest.contributes?.commands).toContainEqual(
      expect.objectContaining({ command: 'breadcrumbs.refreshChatSnapshot' }),
    )
    expect(manifest.contributes?.commands).not.toContainEqual(
      expect.objectContaining({ command: 'breadcrumbs.exportMetadataJson' }),
    )
  })

  it('forwards the selected chat key from report panels to the view loader', async () => {
    const extensionSource = await readFile(path.resolve('src/extension.ts'), 'utf8')
    const panelSource = await readFile(path.resolve('src/webviews/report-panels.ts'), 'utf8')

    expect(extensionSource).toContain('(kind, selectedProvider, selectedChatKey) =>')
    expect(extensionSource).toContain('loadReportView(ctx, kind, selectedProvider, selectedChatKey)')
    expect(extensionSource).toContain("contentMode: vscode.workspace.isTrusted ? 'all' : 'none'")
    expect(extensionSource).toContain('chatDetailContentEnabled: vscode.workspace.isTrusted')
    expect(extensionSource).toContain(
      "vscode.commands.registerCommand('breadcrumbs.openCopilotSetting', (selection?: { setting?: string }) =>",
    )
    expect(extensionSource).toContain(
      // eslint-disable-next-line no-template-curly-in-string -- asserting on literal source text, not a template literal
      "vscode.commands.executeCommand('workbench.action.openSettings', `@id:${selection.setting}`)",
    )
    // Command URIs are scoped to the allowlist (never `true`), and no local resources may load.
    expect(panelSource).toContain('? WEBVIEW_COMMAND_ALLOWLIST : false')
    expect(panelSource).toContain('localResourceRoots: []')
    expect(panelSource).not.toContain('enableCommandUris: true')
  })
})
