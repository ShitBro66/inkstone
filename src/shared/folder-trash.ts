import { z } from 'zod'
import { LIMITS } from './constants'
import type { FolderTrashBackup } from './types'

const id = z.string().regex(/^[0-9a-hjkmnp-tv-z]{26}$/)
const timestamp = z.number().int().positive()
const folderTrashBackup = z.object({
  folders: z.array(z.object({
    id, parentId: id.nullable(), name: z.string().min(1).max(LIMITS.folderNameMaxLength),
    icon: z.string().nullable(), color: z.string().nullable(), position: z.number().finite(),
    createdAt: timestamp, updatedAt: timestamp, deletedAt: timestamp.nullable(),
  })).max(LIMITS.importArchiveEntriesMax),
  groups: z.array(z.object({
    id, rootFolderId: id, deletedAt: timestamp,
    folderIds: z.array(id).max(LIMITS.importArchiveEntriesMax),
    noteIds: z.array(id).max(LIMITS.importArchiveEntriesMax * 4),
    links: z.array(z.object({
      sourceNoteId: id, targetKey: z.string(), targetTitle: z.string(), targetNoteId: id.nullable(),
    })),
  })).max(LIMITS.importArchiveEntriesMax),
})

export function parseFolderTrashBackup(value: unknown): FolderTrashBackup | null {
  const parsed = folderTrashBackup.safeParse(value)
  return parsed.success ? parsed.data : null
}
