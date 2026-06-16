import { homedir } from 'node:os'
import path from 'node:path'
import * as vscode from 'vscode'
import type { AgentId } from '../agent.js'
import { fields, logChannel } from '../log.js'
import { expandHome } from '../path.js'

export function createMetadataIndexWatchers(
  copilotSource: string | undefined,
  onChange: (provider: AgentId) => void,
): vscode.Disposable {
  const watchers = [
    createWatcher(
      'copilot',
      expandHome(copilotSource ?? '~/.cache/vscode-chat-token-usage/copilot-otel.jsonl'),
      false,
      onChange,
    ),
    createWatcher('codex', path.join(homedir(), '.codex', 'sessions'), true, onChange),
    createWatcher('claude', path.join(homedir(), '.claude', 'projects'), true, onChange),
  ]
  return vscode.Disposable.from(...watchers)
}

function createWatcher(
  provider: AgentId,
  source: string,
  directory: boolean,
  onChange: (provider: AgentId) => void,
): vscode.Disposable {
  const base = directory ? source : path.dirname(source)
  const pattern = directory ? '**/*.jsonl' : path.basename(source)
  logChannel().debug(`watch-create ${fields({ provider, base, pattern })}`)
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern))
  const changed = () => onChange(provider)
  return vscode.Disposable.from(
    watcher,
    watcher.onDidCreate(changed),
    watcher.onDidChange(changed),
    watcher.onDidDelete(changed),
  )
}
