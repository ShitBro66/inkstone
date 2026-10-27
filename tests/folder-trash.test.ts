import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { SCHEMA_STATEMENTS, initializeDatabase } from '../src/worker/db/schema'
import { foldersRoutes } from '../src/worker/routes/folders'
import { notesRoutes } from '../src/worker/routes/notes'
import { transferRoutes } from '../src/worker/routes/transfer'
import { buildSnapshot, materializeSnapshot } from '../src/worker/backup/snapshot'
import type { AppBindings } from '../src/worker/env'
import { restoreMcpNote } from '../src/worker/mcp/writes'

vi.mock('../src/worker/lib/notify', () => ({
  broadcastCursor: vi.fn(async () => 0),
  broadcastUserCursor: vi.fn(async () => 0),
  scheduleFtsDrain: vi.fn(),
}))

function d1(database: DatabaseSync): D1Database {
  const prepare = (sql: string, values: unknown[] = []) => {
    const execute = () => {
      const statement = database.prepare(sql)
      const numbers = [...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]))
      const bindings = Object.fromEntries([...new Set(numbers)].map((number) => ['?' + number, values[number - 1]]))
      const results = numbers.length ? statement.all(bindings as never) : statement.all(...values as never[])
      const changes = /^\s*(SELECT|EXPLAIN|PRAGMA)\b/i.test(sql)
        ? 0 : Number(database.prepare('SELECT changes() AS n').get()!.n)
      return { results: results.map((row) => ({ ...row })), success: true, meta: { changes } }
    }
    return {
      bind: (...parameters: unknown[]) => prepare(sql, parameters),
      all: async () => execute(),
      run: async () => execute(),
      first: async (column?: string) => {
        const row = execute().results[0]
        if (!row) return null
        return column ? row[column] : row
      },
    }
  }
  return {
    prepare,
    batch: async (statements: { all: () => Promise<unknown> }[]) => {
      database.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.all())
        database.exec('COMMIT')
        return results
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
}

describe('folder subtree trash and restore', () => {
  let database: DatabaseSync
  let app: Hono<AppBindings>
  let env: AppBindings['Bindings']
  let userId: string

  const folder = (id: string, parentId: string | null, name: string) => {
    database.prepare(`INSERT INTO folders (id, user_id, parent_id, name, position, created_at, updated_at)
      VALUES (?, 'user-a', ?, ?, 1000, 1, 1)`).run(id, parentId, name)
  }
  const note = (id: string, folderId: string | null, deletedAt: number | null = null) => {
    database.prepare(`INSERT INTO notes (id, user_id, folder_id, title, title_key, content, created_at, updated_at, deleted_at)
      VALUES (?, 'user-a', ?, ?, ?, '', 1, 1, ?)`).run(id, folderId, id, id, deletedAt)
  }
  const request = (method: string, path: string, body?: BodyInit) => app.fetch(new Request('https://test.invalid' + path, { method, body }), env)
  const groups = async () => (await (await request('GET', '/api/folders/trash')).json()) as {
    groups: { id: string; rootFolder: { id: string; name: string }; folderCount: number; noteIds: string[] }[]
  }
  const trash = async () => {
    expect((await request('DELETE', '/api/folders/root?strategy=delete')).status).toBe(200)
    return (await groups()).groups[0].id
  }

  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const sql of SCHEMA_STATEMENTS) database.exec(sql)
    userId = 'user-a'
    app = new Hono<AppBindings>()
    app.use('*', async (c, next) => {
      c.set('userId', userId)
      c.set('database', { ftsEnabled: true })
      await next()
    })
    app.onError((error, c) => c.json({ error: error.message }, (error as { status?: 400 }).status ?? 500))
    app.route('/api/folders', foldersRoutes)
    app.route('/api/notes', notesRoutes)
    app.route('/api', transferRoutes)
    env = { DB: d1(database) } as AppBindings['Bindings']
    folder('parent', null, 'Parent')
    folder('root', 'parent', 'Root')
    folder('child', 'root', 'Child')
    folder('grandchild', 'child', 'Grandchild')
    note('note-root', 'root')
    note('note-child', 'child')
    note('note-old-trash', 'child', 10)
    note('note-outside', 'parent')
    database.prepare(`INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id)
      VALUES ('note-root', 'note-outside', 'Outside', 'note-outside', 'user-a')`).run()
  })

  afterEach(() => database.close())

  it('trashes descendants while retaining folder IDs and excluding old trash from the group', async () => {
    await trash()
    const result = (await groups()).groups[0]
    expect(result.rootFolder.id).toBe('root')
    expect(result.folderCount).toBe(3)
    expect(result.noteIds.sort()).toEqual(['note-child', 'note-root'])
    expect(database.prepare("SELECT folder_id FROM notes WHERE id = 'note-child'").get()!.folder_id).toBe('child')
    expect(database.prepare("SELECT deleted_at FROM notes WHERE id = 'note-old-trash'").get()!.deleted_at).toBe(10)
    expect(database.prepare("SELECT deleted_at FROM notes WHERE id = 'note-outside'").get()!.deleted_at).toBeNull()
    expect(database.prepare("SELECT COUNT(*) AS n FROM links WHERE source_note_id = 'note-root'").get()!.n).toBe(0)
  })

  it('reads the original group hierarchy without restoring folders or including unrelated folders', async () => {
    const id = await trash()
    const response = await request('GET', '/api/folders/trash/' + id)
    expect(response.status).toBe(200)
    const detail = await response.json() as { folders: { id: string; parentId: string | null }[] }
    expect(detail.folders.map((entry) => [entry.id, entry.parentId])).toEqual([
      ['child', 'root'], ['grandchild', 'child'], ['root', 'parent'],
    ])
    expect(database.prepare("SELECT COUNT(*) AS n FROM folders WHERE deleted_at IS NOT NULL").get()!.n).toBe(3)
    expect((await request('GET', '/api/notes/note-child')).status).toBe(200)
    userId = 'user-b'
    expect((await request('GET', '/api/folders/trash/' + id)).status).toBe(404)
  })

  it('keeps restored ancestors in the browsing hierarchy for remaining group notes', async () => {
    const id = await trash()
    await request('POST', '/api/notes/note-child/restore')
    const detail = await (await request('GET', '/api/folders/trash/' + id)).json() as { folders: { id: string }[] }
    expect(detail.folders.map((entry) => entry.id)).toEqual(['child', 'grandchild', 'root'])
    expect((await groups()).groups[0].noteIds).toEqual(['note-root'])
  })

  it('restores the whole hierarchy, links and indexing work without restoring previously trashed notes', async () => {
    const id = await trash()
    expect((await request('POST', '/api/folders/trash/' + id + '/restore')).status).toBe(200)
    expect((await groups()).groups).toEqual([])
    expect(database.prepare("SELECT parent_id, deleted_at FROM folders WHERE id = 'child'").get())
      .toEqual({ parent_id: 'root', deleted_at: null })
    expect(database.prepare("SELECT folder_id, deleted_at FROM notes WHERE id = 'note-child'").get())
      .toEqual({ folder_id: 'child', deleted_at: null })
    expect(database.prepare("SELECT deleted_at FROM notes WHERE id = 'note-old-trash'").get()!.deleted_at).toBe(10)
    expect(database.prepare("SELECT target_note_id FROM links WHERE source_note_id = 'note-root'").get()!.target_note_id).toBe('note-outside')
    expect(database.prepare("SELECT kind FROM fts_index_queue WHERE note_id = 'note-root'").get()!.kind).toBe('upsert')
  })

  it('renames restored folders on a case-insensitive name collision', async () => {
    const id = await trash()
    folder('collision', 'parent', 'ROOT')
    expect((await request('POST', '/api/folders/trash/' + id + '/restore')).status).toBe(200)
    expect(database.prepare("SELECT name FROM folders WHERE id = 'root'").get()!.name).toBe('Root (2)')
    expect(database.prepare("SELECT name FROM folders WHERE id = 'collision'").get()!.name).toBe('ROOT')
  })

  it('restores a parent that was removed later using the original move-up action', async () => {
    const id = await trash()
    expect((await request('DELETE', '/api/folders/parent')).status).toBe(200)
    expect((await request('POST', '/api/folders/trash/' + id + '/restore')).status).toBe(200)
    expect(database.prepare("SELECT parent_id, deleted_at FROM folders WHERE id = 'root'").get())
      .toEqual({ parent_id: 'parent', deleted_at: null })
    expect(database.prepare("SELECT deleted_at FROM folders WHERE id = 'parent'").get()!.deleted_at).toBeNull()
    expect(database.prepare("SELECT folder_id FROM notes WHERE id = 'note-outside'").get()!.folder_id).toBeNull()
  })

  it('keeps independently deleted notes out of a later group restore', async () => {
    const id = await trash()
    expect((await request('POST', '/api/notes/note-root/restore')).status).toBe(200)
    expect((await request('DELETE', '/api/notes/note-root')).status).toBe(200)
    expect((await request('POST', '/api/folders/trash/' + id + '/restore')).status).toBe(200)
    expect(database.prepare("SELECT deleted_at FROM notes WHERE id = 'note-root'").get()!.deleted_at).not.toBeNull()
    expect(database.prepare("SELECT deleted_at FROM notes WHERE id = 'note-child'").get()!.deleted_at).toBeNull()
  })

  it('keeps the group recoverable after one note is permanently purged', async () => {
    const id = await trash()
    expect((await request('DELETE', '/api/notes/note-root/purge')).status).toBe(200)
    expect((await request('POST', '/api/folders/trash/' + id + '/restore')).status).toBe(200)
    expect(database.prepare("SELECT id FROM notes WHERE id = 'note-root'").get()).toBeUndefined()
    expect(database.prepare("SELECT deleted_at FROM notes WHERE id = 'note-child'").get()!.deleted_at).toBeNull()
  })

  it('rebuilds current links when a note version was changed while the group was in trash', async () => {
    const id = await trash()
    database.prepare(`UPDATE notes SET content = '[[note-child]]', content_hash = 'changed',
      rev = rev + 1, updated_at = deleted_at + 1 WHERE id = 'note-root'`).run()
    expect((await request('POST', '/api/folders/trash/' + id + '/restore')).status).toBe(200)
    const links = database.prepare("SELECT target_key, target_note_id FROM links WHERE source_note_id = 'note-root'").all()
    expect(links).toEqual([{ target_key: 'note-child', target_note_id: 'note-child' }])
  })

  it('keeps concurrently changed notes in a recoverable group for a retry', async () => {
    const id = await trash()
    const batch = env.DB.batch.bind(env.DB)
    env.DB.batch = async (statements) => {
      database.prepare("UPDATE notes SET rev = rev + 1, updated_at = updated_at + 1 WHERE id = 'note-child'").run()
      return batch(statements)
    }
    expect((await request('POST', '/api/folders/trash/' + id + '/restore')).status).toBe(409)
    env.DB.batch = batch
    expect((await groups()).groups[0].noteIds).toEqual(['note-child'])
    expect((await request('POST', '/api/folders/trash/' + id + '/restore')).status).toBe(200)
    expect((await groups()).groups).toEqual([])
  })

  it('clears an empty folder group as well as ordinary note trash', async () => {
    database.exec("DELETE FROM notes; DELETE FROM links")
    await trash()
    expect((await request('POST', '/api/notes/trash/empty')).status).toBe(200)
    expect((await groups()).groups).toEqual([])
    expect(database.prepare("SELECT id FROM folders WHERE id = 'root'").get()).toBeUndefined()
    expect(database.prepare("SELECT id FROM folders WHERE id = 'parent'").get()!.id).toBe('parent')
  })

  it('does not expose or restore another account\'s folder group', async () => {
    const id = await trash()
    userId = 'user-b'
    expect((await groups()).groups).toEqual([])
    expect((await request('POST', '/api/folders/trash/' + id + '/restore')).status).toBe(404)
    expect((await request('DELETE', '/api/folders/parent?strategy=delete')).status).toBe(404)
  })

  it('restores folder ancestors when one grouped note is recovered through MCP', async () => {
    await trash()
    const current = database.prepare("SELECT rev FROM notes WHERE id = 'note-child'").get()!
    const restored = await restoreMcpNote({
      env, userId, ftsEnabled: false,
      executionCtx: { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext,
    }, { operationId: 'restore-folder-note-001', noteId: 'note-child', expectedRev: Number(current.rev) })
    expect(restored.folderId).toBe('child')
    expect(database.prepare("SELECT deleted_at FROM folders WHERE id = 'root'").get()!.deleted_at).toBeNull()
    expect(database.prepare("SELECT deleted_at FROM notes WHERE id = 'note-root'").get()!.deleted_at).not.toBeNull()
  })

  it('restores a large note group with bulk SQL and queues its full-text work', async () => {
    database.exec('DELETE FROM links; DELETE FROM notes')
    for (let index = 0; index < 450; index++) note('bulk-note-' + index, 'child')
    const id = await trash()
    expect((await groups()).groups[0].noteIds).toHaveLength(450)
    expect((await request('POST', '/api/folders/trash/' + id + '/restore')).status).toBe(200)
    expect(database.prepare("SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL").get()!.n).toBe(450)
    expect(database.prepare("SELECT COUNT(*) AS n FROM fts_index_queue WHERE kind = 'upsert'").get()!.n).toBe(450)
  })

  it('adds the trash table when upgrading a database already at migration 12', async () => {
    database.exec('DROP TABLE folder_trash_groups')
    for (let version = 1; version <= 12; version++) database.prepare('INSERT INTO schema_migrations VALUES (?, 1)').run(version)
    await initializeDatabase(env)
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 14").get()!.version).toBe(14)
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'folder_trash_groups'").get()!.name).toBe('folder_trash_groups')
  })

  for (const format of ['json', 'markdown'] as const) {
    it(`preserves the trashed hierarchy through a ${format} backup imported into another account`, async () => {
      database.exec('DELETE FROM links; DELETE FROM notes; DELETE FROM folders; DELETE FROM folder_trash_groups')
      const parent = '1'.padStart(26, '0')
      const root = '2'.padStart(26, '0')
      const child = '3'.padStart(26, '0')
      const item = '4'.padStart(26, '0')
      folder(parent, null, 'Parent')
      folder(root, parent, 'Root')
      folder(child, root, 'Child')
      note(item, child)
      expect((await request('DELETE', '/api/folders/' + root + '?strategy=delete')).status).toBe(200)
      const form = new FormData()
      if (format === 'json') {
        const response = await request('GET', '/api/export?format=json')
        expect(response.status).toBe(200)
        form.append('file', new File([await response.text()], 'backup.json', { type: 'application/json' }))
      } else {
        const snapshot = await buildSnapshot(env, 'user-a')
        const manifest = await new Response(await snapshot.manifestFile.open()).json()
        const files = (await materializeSnapshot(snapshot)).filter((file) => file.path.endsWith('.md'))
        form.set('backupManifest', JSON.stringify(manifest))
        form.set('backupPaths', JSON.stringify(files.map((file) => file.path)))
        for (const file of files) form.append('file', new File([file.body], 'note.md', { type: 'text/markdown' }))
      }
      userId = 'user-b'
      const imported = await request('POST', '/api/import', form)
      const importResult = await imported.json()
      expect(imported.status, JSON.stringify(importResult)).toBe(200)
      const recovered = (await groups()).groups
      expect(recovered, JSON.stringify(importResult)).toHaveLength(1)
      expect(recovered[0].folderCount).toBe(2)
      expect(recovered[0].noteIds).toHaveLength(1)
      const activeFolders = await (await request('GET', '/api/folders')).json() as { folders: { name: string }[] }
      expect(activeFolders.folders.map((entry) => entry.name)).toEqual(['Parent'])
      expect((await request('POST', '/api/folders/trash/' + recovered[0].id + '/restore')).status).toBe(200)
      const restoredNote = database.prepare('SELECT folder_id, deleted_at FROM notes WHERE id = ?').get(recovered[0].noteIds[0])!
      expect(restoredNote.deleted_at).toBeNull()
      const restoredFolder = database.prepare('SELECT name, parent_id FROM folders WHERE id = ?').get(restoredNote.folder_id as string)!
      expect(restoredFolder.name).toBe('Child')
      expect(database.prepare('SELECT name FROM folders WHERE id = ?').get(restoredFolder.parent_id as string)!.name).toBe('Root')
      expect(database.prepare('SELECT deleted_at FROM notes WHERE id = ?').get(item)!.deleted_at).not.toBeNull()
    })
  }
})
