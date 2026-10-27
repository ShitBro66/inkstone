import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder, FolderTrashGroup, NoteSummary } from '@shared/types'
import { useNotes } from './notes'
import { api } from '../lib/api'
import { localDb } from '../lib/db'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      folders: { ...actual.api.folders, remove: vi.fn(), trash: vi.fn(), restoreTrash: vi.fn() },
      notes: { ...actual.api.notes, emptyTrash: vi.fn() },
    },
  }
})

vi.mock('../lib/db', () => ({
  publishBroadcast: vi.fn(),
  localDb: {
    scheduleShellSave: vi.fn(),
    dropContent: vi.fn(),
    setContent: vi.fn(),
    getOutbox: vi.fn(async () => []),
  },
}))

const root: Folder = { id: 'root', parentId: null, name: 'Root', icon: null, color: null, position: 1, createdAt: 1, updatedAt: 1 }
const child: Folder = { ...root, id: 'child', parentId: 'root', name: 'Child' }
const note: NoteSummary = {
  id: 'note', title: 'Fixture', excerpt: '', folderId: 'child', tags: [], isPinned: false,
  isStarred: false, isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 1,
  createdAt: 1, updatedAt: 1, deletedAt: null,
}
const group: FolderTrashGroup = { id: 'group', rootFolder: root, deletedAt: 10, folderCount: 2, noteIds: ['note'] }

beforeEach(() => {
  vi.clearAllMocks()
  useNotes.setState({ folders: [root, child], notes: { note }, contents: {}, folderTrash: [], pull: vi.fn(async () => {}), flush: vi.fn(async () => {}) })
  vi.mocked(api.folders.remove).mockResolvedValue({ ok: true })
  vi.mocked(api.folders.restoreTrash).mockResolvedValue({ ok: true })
  vi.mocked(api.folders.trash).mockResolvedValue({ groups: [group] })
  vi.mocked(api.notes.emptyTrash).mockResolvedValue({ purged: 0 })
})

describe('folder trash client actions', () => {
  it('uses the existing recursive delete strategy then refreshes notes and trash groups', async () => {
    expect(await useNotes.getState().trashFolder('root')).toBe(true)
    expect(api.folders.remove).toHaveBeenCalledWith('root', 'delete')
    expect(useNotes.getState().pull).toHaveBeenCalledWith({ force: true })
    expect(useNotes.getState().folderTrash).toEqual([group])
  })

  it('keeps current state intact when deletion fails', async () => {
    vi.mocked(api.folders.remove).mockRejectedValueOnce(new Error('request failed'))
    expect(await useNotes.getState().trashFolder('root')).toBe(false)
    expect(useNotes.getState().folders).toEqual([root, child])
    expect(useNotes.getState().notes.note.deletedAt).toBeNull()
    expect(useNotes.getState().pull).not.toHaveBeenCalled()
  })

  it('cancels deletion when a descendant note still has an unsynced write', async () => {
    vi.mocked(localDb.getOutbox).mockResolvedValueOnce([{
      id: 'pending', clientId: 'client', writeId: 'write', noteId: 'note',
      payload: { content: 'pending', rev: 1 }, attempts: 0, createdAt: 1,
    }])
    expect(await useNotes.getState().trashFolder('root')).toBe(false)
    expect(api.folders.remove).not.toHaveBeenCalled()
    expect(useNotes.getState().notes.note.deletedAt).toBeNull()
  })

  it('restores a group and refreshes the original hierarchy', async () => {
    vi.mocked(api.folders.trash).mockResolvedValueOnce({ groups: [] })
    useNotes.setState({ folderTrash: [group] })
    expect(await useNotes.getState().restoreFolderTrash('group')).toBe(true)
    expect(api.folders.restoreTrash).toHaveBeenCalledWith('group')
    expect(useNotes.getState().pull).toHaveBeenCalledWith({ force: true })
    expect(useNotes.getState().folderTrash).toEqual([])
  })

  it('does not report a committed delete as failed when the following refresh is unavailable', async () => {
    useNotes.setState({ pull: vi.fn(async () => { throw new Error('refresh unavailable') }) })
    expect(await useNotes.getState().trashFolder('root')).toBe(true)
    expect(api.folders.remove).toHaveBeenCalledWith('root', 'delete')
  })

  it('does not report a committed restore as failed when the following refresh is unavailable', async () => {
    useNotes.setState({ pull: vi.fn(async () => { throw new Error('refresh unavailable') }) })
    expect(await useNotes.getState().restoreFolderTrash('group')).toBe(true)
    expect(api.folders.restoreTrash).toHaveBeenCalledWith('group')
  })

  it('clears folder-only trash even when there are no trashed notes', async () => {
    useNotes.setState({ notes: {}, folderTrash: [{ ...group, noteIds: [] }] })
    expect(await useNotes.getState().emptyTrash()).toBe(0)
    expect(api.notes.emptyTrash).toHaveBeenCalledOnce()
    expect(useNotes.getState().folderTrash).toEqual([])
  })

  it('ignores a stale trash list response', async () => {
    let resolveFirst!: (value: { groups: FolderTrashGroup[] }) => void
    vi.mocked(api.folders.trash).mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
    const first = useNotes.getState().refreshFolderTrash()
    vi.mocked(api.folders.trash).mockResolvedValueOnce({ groups: [] })
    await useNotes.getState().refreshFolderTrash()
    resolveFirst({ groups: [group] })
    await first
    expect(useNotes.getState().folderTrash).toEqual([])
  })
})
