import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { ChatMetadata } from '../chat-metadata.js'
import { expandHome } from '../path.js'

interface CodexTitleRow {
  id: string
  title: string
}

export async function applyCodexTitles(chats: ChatMetadata[], sessionsRoot: string): Promise<ChatMetadata[]> {
  const databasePath = path.join(path.dirname(expandHome(sessionsRoot)), 'state_5.sqlite')
  if (!(await isFile(databasePath))) return chats

  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const rows = database
        .prepare("SELECT id, title FROM threads WHERE title <> ''")
        .all() as unknown as CodexTitleRow[]
      const titles = new Map(rows.map((row) => [row.id, normalizeTitle(row.title)]))
      return chats.map((chat) => ({
        ...chat,
        title: titles.get(chat.providerChatId) || chat.title,
      }))
    } finally {
      database.close()
    }
  } catch {
    return chats
  }
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
