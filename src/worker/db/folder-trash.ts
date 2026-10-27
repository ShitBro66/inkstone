import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import type { FolderTrashBackup, FolderTrashGroup } from '@shared/types'
import { NOTE_COLUMNS_FULL, toFolder, type FolderRow, type NoteRow } from './rows'
import { buildNoteDerivedStatements, FTS_QUEUE_CONFLICT_SQL, LINK_TARGET_SUBQUERY } from './writes'
import { ApiError } from '../lib/errors'
import { sha256Hex } from '../lib/encoding'

interface StoredFolder extends FolderRow {
  user_id: string
  deleted_at: number | null
}

interface StoredGroup {
  id: string
  root_folder_id: string
  deleted_at: number
  folder_ids_json: string
  note_ids_json: string
  links_json: string
}

const FOLDER_COLUMNS = `id, user_id, parent_id, name, icon, color, position, created_at, updated_at, deleted_at`

export async function listFolderTrash(db: D1Database, userId: string): Promise<FolderTrashGroup[]> {
  const { results } = await db.prepare(
    `SELECT g.id AS group_id, g.deleted_at AS group_deleted_at,
       f.id, f.parent_id, f.name, f.icon, f.color, f.position, f.created_at, f.updated_at,
       (SELECT COUNT(*) FROM json_each(g.folder_ids_json) item CROSS JOIN folders child
         WHERE child.id = item.value AND child.user_id = ?1 AND child.deleted_at = g.deleted_at) AS folder_count,
       (SELECT json_group_array(n.id) FROM json_each(g.note_ids_json) item CROSS JOIN notes n
         WHERE n.id = item.value AND n.user_id = ?1 AND n.deleted_at = g.deleted_at) AS note_ids_json
     FROM folder_trash_groups g JOIN folders f ON f.id = g.root_folder_id AND f.user_id = g.user_id
     WHERE g.user_id = ?1 ORDER BY g.deleted_at DESC, g.id DESC`,
  ).bind(userId).all<FolderRow & {
    group_id: string
    group_deleted_at: number
    folder_count: number
    note_ids_json: string
  }>()
  return results.map((row) => ({
    id: row.group_id,
    rootFolder: toFolder(row),
    deletedAt: row.group_deleted_at,
    folderCount: row.folder_count,
    noteIds: JSON.parse(row.note_ids_json) as string[],
  })).filter((group) => group.folderCount > 0 || group.noteIds.length > 0)
}

export async function folderRestoreStatements(
  db: D1Database,
  userId: string,
  folderIds: readonly string[],
  now: number,
): Promise<D1PreparedStatement[]> {
  if (!folderIds.length) return []
  const { results } = await db.prepare(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE user_id = ?1`)
    .bind(userId).all<StoredFolder>()
  const folders = new Map(results.map((folder) => [folder.id, folder]))
  const planned = new Map<string, { id: string; name: string }>()
  const visiting = new Set<string>()
  const names = new Map<string | null, Set<string>>()
  for (const folder of results) {
    if (folder.deleted_at !== null) continue
    let siblings = names.get(folder.parent_id)
    if (!siblings) names.set(folder.parent_id, siblings = new Set())
    siblings.add(folder.name.toLowerCase())
  }
  const visit = (id: string): void => {
    if (planned.has(id)) return
    const folder = folders.get(id)
    if (!folder) throw ApiError.conflict('The original parent folder no longer exists')
    if (visiting.has(id)) throw ApiError.conflict('The folder hierarchy contains a cycle')
    if (folder.deleted_at === null) return
    visiting.add(id)
    if (folder.parent_id) visit(folder.parent_id)
    let siblings = names.get(folder.parent_id)
    if (!siblings) names.set(folder.parent_id, siblings = new Set())
    let name = folder.name
    for (let suffix = 2; siblings.has(name.toLowerCase()); suffix++) {
      const ending = ` (${suffix})`
      name = truncateText(folder.name, LIMITS.folderNameMaxLength - ending.length) + ending
    }
    siblings.add(name.toLowerCase())
    planned.set(id, { id, name })
    visiting.delete(id)
  }
  for (const id of folderIds) visit(id)
  if (!planned.size) return []
  const json = JSON.stringify([...planned.values()])
  return [
    db.prepare(
      `UPDATE folders SET deleted_at = NULL,
         name = (SELECT json_extract(value, '$.name') FROM json_each(?3)
           WHERE json_extract(value, '$.id') = folders.id),
         updated_at = MAX(updated_at + 1, ?2)
       WHERE user_id = ?1 AND deleted_at IS NOT NULL
         AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?3))`,
    ).bind(userId, now, json),
    db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'folder', id, 'upsert', ?2 FROM folders
       WHERE user_id = ?1 AND deleted_at IS NULL
         AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?3))`,
    ).bind(userId, now, json),
  ]
}

export async function restoreFolderTrash(
  db: D1Database,
  userId: string,
  groupId: string,
  ftsEnabled: boolean,
): Promise<void> {
  const group = await db.prepare(`SELECT * FROM folder_trash_groups WHERE id = ?1 AND user_id = ?2`)
    .bind(groupId, userId).first<StoredGroup>()
  if (!group) throw ApiError.notFound('Folder trash group not found')
  const now = Date.now()
  const folderIds = JSON.parse(group.folder_ids_json) as string[]
  const { results: notes } = await db.prepare(
    `SELECT id, rev, folder_id, updated_at FROM notes WHERE user_id = ?1 AND deleted_at = ?2
       AND id IN (SELECT value FROM json_each(?3))`,
  ).bind(userId, group.deleted_at, group.note_ids_json)
    .all<{ id: string; rev: number; folder_id: string | null; updated_at: number }>()
  const restoreFolders = [...folderIds]
  for (const note of notes) if (note.folder_id) restoreFolders.push(note.folder_id)
  const statements = await folderRestoreStatements(db, userId, restoreFolders, now)
  const revisions = JSON.stringify(notes.map((note) => ({ id: note.id, rev: note.rev + 1 })))
  const restoredNotes = `SELECT n.id FROM json_each(?3) item CROSS JOIN notes n
    WHERE n.id = json_extract(item.value, '$.id') AND n.rev = json_extract(item.value, '$.rev')
      AND n.user_id = ?1 AND n.deleted_at IS NULL`
  statements.push(
    db.prepare(
      `UPDATE notes SET deleted_at = NULL, updated_at = MAX(updated_at + 1, ?2), rev = rev + 1
       WHERE user_id = ?1 AND deleted_at = ?4 AND (id, rev) IN (
         SELECT json_extract(item.value, '$.id'), json_extract(item.value, '$.rev') - 1 FROM json_each(?3) item)`,
    ).bind(userId, now, revisions, group.deleted_at),
    db.prepare(
      `INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id)
       SELECT json_extract(item.value, '$.sourceNoteId'), json_extract(item.value, '$.targetKey'),
         json_extract(item.value, '$.targetTitle'), NULL, ?1 FROM json_each(?4) item
       WHERE json_extract(item.value, '$.sourceNoteId') IN (${restoredNotes})
       ON CONFLICT(source_note_id, target_key) DO NOTHING`,
    ).bind(userId, now, revisions, group.links_json),
    db.prepare(
      `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
       WHERE user_id = ?1 AND (source_note_id IN (${restoredNotes}) OR target_key IN (
         SELECT title_key FROM notes WHERE id IN (${restoredNotes})))`,
    ).bind(userId, now, revisions),
    db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', id, 'upsert', ?2 FROM notes WHERE id IN (${restoredNotes})`,
    ).bind(userId, now, revisions),
    db.prepare(
      `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
       SELECT ?1, id, 'embed', MAX(?2, COALESCE((SELECT created_at + 1 FROM ai_index_queue
         WHERE user_id = ?1 AND note_id = notes.id), ?2)) FROM notes WHERE id IN (${restoredNotes})
         AND EXISTS (SELECT 1 FROM app_meta WHERE key = ?4 AND value = '1')`,
    ).bind(userId, now, revisions, `ai-search-enabled:${userId}`),
  )
  if (ftsEnabled) statements.push(db.prepare(
    `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
     SELECT ?1, id, 'upsert', ?2 FROM notes WHERE id IN (${restoredNotes})
     ${FTS_QUEUE_CONFLICT_SQL}`,
  ).bind(userId, now, revisions))
  // Version recovery can change a note while it is in trash; rebuild only those notes from their current body.
  const editedIds = notes.filter((note) => note.updated_at > group.deleted_at).map((note) => note.id)
  if (editedIds.length) {
    const edited = await db.prepare(`SELECT ${NOTE_COLUMNS_FULL} FROM notes n
      WHERE n.user_id = ?1 AND n.deleted_at = ?2 AND n.id IN (SELECT value FROM json_each(?3))`)
      .bind(userId, group.deleted_at, JSON.stringify(editedIds)).all<NoteRow>()
    for (const note of edited.results) {
      statements.push(...buildNoteDerivedStatements({
        db, userId, noteId: note.id, title: note.title, content: note.content, ftsEnabled,
        titleChanged: true, expectedRev: note.rev + 1, expectedContentHash: note.content_hash,
        expectedTitle: note.title, expectedUpdatedAt: Math.max(note.updated_at + 1, now),
      }).statements)
    }
  }
  statements.push(db.prepare(`DELETE FROM folder_trash_groups WHERE id = ?1 AND user_id = ?2
    AND NOT EXISTS (SELECT 1 FROM notes WHERE user_id = ?2 AND deleted_at = ?3
      AND id IN (SELECT value FROM json_each(?4)))`)
    .bind(groupId, userId, group.deleted_at, group.note_ids_json))
  await db.batch(statements)
  const remaining = await db.prepare(`SELECT id FROM folder_trash_groups WHERE id = ?1 AND user_id = ?2`)
    .bind(groupId, userId).first<{ id: string }>()
  if (remaining) throw ApiError.conflict('Some notes changed during restore. Refresh and restore the remaining group again')
}

export async function exportFolderTrash(db: D1Database, userId: string): Promise<FolderTrashBackup> {
  const [folderRows, groupRows] = await db.batch([
    db.prepare(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE user_id = ?1`).bind(userId),
    db.prepare(`SELECT * FROM folder_trash_groups WHERE user_id = ?1`).bind(userId),
  ])
  return {
    folders: (folderRows as D1Result<StoredFolder>).results.map((row) => ({ ...toFolder(row), deletedAt: row.deleted_at })),
    groups: (groupRows as D1Result<StoredGroup>).results.map((row) => ({
      id: row.id, rootFolderId: row.root_folder_id, deletedAt: row.deleted_at,
      folderIds: JSON.parse(row.folder_ids_json) as string[],
      noteIds: JSON.parse(row.note_ids_json) as string[],
      links: JSON.parse(row.links_json) as FolderTrashBackup['groups'][number]['links'],
    })),
  }
}

export async function importFolderTrash(
  db: D1Database,
  userId: string,
  backup: FolderTrashBackup,
  folderIdMap: Map<string, string>,
  noteIdMap: ReadonlyMap<string, string>,
  noteFolders: ReadonlyMap<string, string | null>,
): Promise<void> {
  const source = new Map(backup.folders.map((folder) => [folder.id, folder]))
  const visiting = new Set<string>()
  const resolve = async (id: string): Promise<string> => {
    const mapped = folderIdMap.get(id)
    if (mapped) return mapped
    const folder = source.get(id)
    if (!folder || visiting.has(id)) throw ApiError.badRequest('The folder trash backup hierarchy is invalid')
    visiting.add(id)
    const parentId = folder.parentId === null ? null : await resolve(folder.parentId)
    const own = await db.prepare(`SELECT id FROM folders WHERE id = ?1 AND user_id = ?2`)
      .bind(id, userId).first<{ id: string }>()
    let targetId = own?.id
    if (!targetId && folder.deletedAt === null) {
      const existing = await db.prepare(`SELECT id FROM folders
        WHERE user_id = ?1 AND parent_id IS ?2 AND lower(name) = lower(?3) AND deleted_at IS NULL`)
        .bind(userId, parentId, folder.name).first<{ id: string }>()
      targetId = existing?.id
    }
    if (!targetId) {
      targetId = (await sha256Hex(`${userId}:folder-trash:${id}`)).slice(0, 26)
      const inserted = await db.prepare(`INSERT INTO folders
        (id, user_id, parent_id, name, icon, color, position, created_at, updated_at, deleted_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(id) DO UPDATE SET updated_at = folders.updated_at WHERE folders.user_id = excluded.user_id`)
        .bind(targetId, userId, parentId, folder.name, folder.icon, folder.color, folder.position,
          folder.createdAt, folder.updatedAt, folder.deletedAt).run()
      if (!inserted.meta.changes) throw ApiError.conflict('The folder backup identifier is already in use')
      await db.prepare(`INSERT INTO changes (user_id, entity, entity_id, op, at) VALUES (?1, 'folder', ?2, ?3, ?4)`)
        .bind(userId, targetId, folder.deletedAt === null ? 'upsert' : 'delete', Date.now()).run()
    }
    folderIdMap.set(id, targetId)
    visiting.delete(id)
    return targetId
  }
  for (const folder of backup.folders) await resolve(folder.id)
  const noteLocations: { id: string; folderId: string }[] = []
  for (const [sourceId, folderId] of noteFolders) {
    const noteId = noteIdMap.get(sourceId)
    if (noteId && folderId !== null && folderIdMap.has(folderId)) {
      noteLocations.push({ id: noteId, folderId: folderIdMap.get(folderId)! })
    }
  }
  await db.prepare(`UPDATE notes SET folder_id = (
    SELECT json_extract(value, '$.folderId') FROM json_each(?2) WHERE json_extract(value, '$.id') = notes.id)
    WHERE user_id = ?1 AND deleted_at IS NOT NULL
      AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`)
    .bind(userId, JSON.stringify(noteLocations)).run()
  for (const group of backup.groups) {
    const rootFolderId = folderIdMap.get(group.rootFolderId)
    if (!rootFolderId) throw ApiError.badRequest('The folder trash backup root is missing')
    const mappedNotes = group.noteIds.flatMap((id) => noteIdMap.has(id) ? [noteIdMap.get(id)!] : [])
    const mappedFolders = group.folderIds.map((id) => folderIdMap.get(id))
    if (mappedFolders.some((id) => id === undefined)) throw ApiError.badRequest('The folder trash backup member is missing')
    const links = group.links.flatMap((link) => {
      const sourceNoteId = noteIdMap.get(link.sourceNoteId)
      if (!sourceNoteId) return []
      return [{ ...link, sourceNoteId, targetNoteId: link.targetNoteId === null ? null : noteIdMap.get(link.targetNoteId) ?? null }]
    })
    const existingGroup = await db.prepare(`SELECT id FROM folder_trash_groups WHERE id = ?1 AND user_id = ?2`)
      .bind(group.id, userId).first<{ id: string }>()
    const id = existingGroup ? existingGroup.id : (await sha256Hex(`${userId}:folder-trash-group:${group.id}`)).slice(0, 26)
    await db.prepare(`INSERT INTO folder_trash_groups
      (id, user_id, root_folder_id, deleted_at, folder_ids_json, note_ids_json, links_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(id) DO UPDATE SET folder_ids_json = excluded.folder_ids_json,
        note_ids_json = excluded.note_ids_json, links_json = excluded.links_json`)
      .bind(id, userId, rootFolderId, group.deletedAt, JSON.stringify(mappedFolders), JSON.stringify(mappedNotes), JSON.stringify(links)).run()
  }
}
