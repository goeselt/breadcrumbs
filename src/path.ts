import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export interface FileProbe {
  path: string
  exists: boolean
  kind: 'file' | 'directory' | 'missing' | 'other'
  size?: number
}

export function expandHome(input: string, home = homedir()): string {
  if (input === '~') return home
  if (input.startsWith('~/')) return path.join(home, input.slice(2))
  return input
}

export function toHomeRelative(input: string, home = homedir()): string {
  const resolvedHome = path.resolve(home)
  const resolvedInput = path.resolve(input)
  if (resolvedInput === resolvedHome) return '~'
  if (resolvedInput.startsWith(`${resolvedHome}${path.sep}`)) return `~/${path.relative(resolvedHome, resolvedInput)}`
  return input
}

export async function probePath(input: string): Promise<FileProbe> {
  try {
    await access(input, constants.F_OK)
    const info = await stat(input)
    if (info.isFile()) return { path: input, exists: true, kind: 'file', size: info.size }
    if (info.isDirectory()) return { path: input, exists: true, kind: 'directory' }
    return { path: input, exists: true, kind: 'other' }
  } catch {
    return { path: input, exists: false, kind: 'missing' }
  }
}
