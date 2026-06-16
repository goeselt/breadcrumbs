import * as vscode from 'vscode'

let channel: vscode.LogOutputChannel | undefined

/**
 * The structured diagnostic log, separate from the human-triggered "Breadcrumbs" report dumps.
 * Shows up as its own entry in the Output view's channel dropdown. Verbosity is controlled by
 * the user via "Developer: Set Log Level..." -> Breadcrumbs Log, so call sites can log liberally
 * at `trace`/`debug` without flooding the default view (which only shows `info` and above).
 */
export function logChannel(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Breadcrumbs Log', { log: true })
  return channel
}

export function disposeLogChannel(): void {
  channel?.dispose()
  channel = undefined
}

/**
 * Formats a fields object as logfmt-style `key=value` pairs for greppable, structurally
 * consistent log lines. Undefined values are omitted; values containing whitespace or quotes
 * are JSON-quoted.
 */
export function fields(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatFieldValue(value)}`)
    .join(' ')
}

function formatFieldValue(value: unknown): string {
  if (typeof value !== 'string') return String(value)
  return /[\s"=]/.test(value) ? JSON.stringify(value) : value
}
