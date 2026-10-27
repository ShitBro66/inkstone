import { beforeEach, describe, expect, it } from 'vitest'
import { createDemoBackend } from './backend'
import { DEMO_CREDENTIALS } from '../lib/runtime'

describe('demo folder trash', () => {
  let backend: ReturnType<typeof createDemoBackend>
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await backend.fetch(new Request('https://demo.invalid' + path, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    expect(response.status).toBeLessThan(400)
    return response.json()
  }
  beforeEach(async () => {
    backend = createDemoBackend()
    await request('POST', '/api/auth/login', DEMO_CREDENTIALS)
  })

  it('recovers folder hierarchy while preserving notes previously moved to trash', async () => {
    const root = await request('POST', '/api/folders', { name: 'Fixture root' })
    const child = await request('POST', '/api/folders', { name: 'Fixture child', parentId: root.id })
    const current = await request('POST', '/api/notes', { title: 'Current fixture', content: '', folderId: child.id })
    const older = await request('POST', '/api/notes', { title: 'Old fixture', content: '', folderId: child.id })
    await request('DELETE', '/api/notes/' + older.id)
    await request('DELETE', '/api/folders/' + root.id + '?strategy=delete')
    const deleted = await request('GET', '/api/folders/trash')
    expect(deleted.groups[0].folderCount).toBe(2)
    expect(deleted.groups[0].noteIds).toEqual([current.id])
    const detail = await request('GET', '/api/folders/trash/' + deleted.groups[0].id)
    expect(detail.folders.map((folder: { id: string; parentId: string | null }) => [folder.id, folder.parentId]))
      .toEqual([[root.id, null], [child.id, root.id]])
    await request('POST', '/api/folders/trash/' + deleted.groups[0].id + '/restore')
    const folders = await request('GET', '/api/folders')
    expect(folders.folders.find((folder: { id: string }) => folder.id === child.id).parentId).toBe(root.id)
    expect((await request('GET', '/api/notes/' + current.id)).deletedAt).toBeNull()
    expect((await request('GET', '/api/notes/' + older.id)).deletedAt).not.toBeNull()
  })

  it('clears an empty deleted folder group', async () => {
    const root = await request('POST', '/api/folders', { name: 'Empty fixture root' })
    await request('DELETE', '/api/folders/' + root.id + '?strategy=delete')
    expect((await request('GET', '/api/folders/trash')).groups).toHaveLength(1)
    await request('POST', '/api/notes/trash/empty')
    expect((await request('GET', '/api/folders/trash')).groups).toEqual([])
  })
})
