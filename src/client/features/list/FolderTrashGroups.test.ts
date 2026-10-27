import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/constants'
import type { Folder, FolderTrashGroup, Note } from '@shared/types'
import { api } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { FolderTrashGroups } from './FolderTrashGroups'
import { Preview } from '../preview/Preview'

const folder = (id: string, parentId: string | null): Folder => ({
  id, parentId, name: id, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1,
})
const folders = [folder('Root fixture', null), folder('Child fixture', 'Root fixture'), folder('Leaf fixture', 'Child fixture')]
const note: Note = {
  id: 'fixture-note', title: 'Deleted fixture', folderId: 'Leaf fixture', content: '# Deleted fixture\n\n- [ ] Task\n\n[[Missing trash target]]',
  excerpt: '', tags: [], isPinned: false, isStarred: false, isArchived: false,
  wordCount: 1, charCount: 1, rev: 2, position: 0, createdAt: 1, updatedAt: 2, deletedAt: 2,
}
const group: FolderTrashGroup = { id: 'fixture-group', rootFolder: folders[0], deletedAt: 2, folderCount: 3, noteIds: [note.id] }
let container: HTMLDivElement
let root: Root
let restoreNotes: () => void
let restoreSession: () => void

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  await initI18n()
  const previousNotes = useNotes.getState()
  const previousSession = useSession.getState()
  restoreNotes = () => useNotes.setState(previousNotes)
  restoreSession = () => useSession.setState(previousSession)
  useNotes.setState({ notes: { [note.id]: note }, folders: [], contents: {}, editContent: vi.fn(), createNote: vi.fn() })
  useSession.setState({ settings: mergeSettings({}) })
  vi.spyOn(api.folders, 'trashFolders').mockResolvedValue({ folders })
  vi.spyOn(api.notes, 'get').mockResolvedValue(note)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  restoreNotes()
  restoreSession()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('browsing folder trash', () => {
  it('preserves task editing in normal note previews', async () => {
    await act(() => root.render(createElement(Preview, { content: '- [ ] Task', noteId: note.id })))
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.disabled).toBe(false)
    await act(() => checkbox.click())
    expect(useNotes.getState().editContent).toHaveBeenCalledWith(note.id, '- [x] Task')
  })

  it('starts collapsed, loads folders once on expansion, and keeps every child folder collapsed', async () => {
    await act(() => root.render(createElement(FolderTrashGroups, { groups: [group] })))
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('details')).toBeNull()
    expect(api.folders.trashFolders).not.toHaveBeenCalled()
    expect(api.notes.get).not.toHaveBeenCalled()
    await act(() => toggle.click())
    expect(api.folders.trashFolders).toHaveBeenCalledExactlyOnceWith(group.id)
    const details = [...container.querySelectorAll('details')]
    expect(details).toHaveLength(2)
    expect(details.every((item) => !item.open)).toBe(true)
    expect(details[0].querySelector('summary')?.textContent).toBe('Child fixture')
    expect(details[1].querySelector('summary')?.textContent).toBe('Leaf fixture')
    await act(() => details[0].querySelector('summary')!.click())
    expect(details[0].open).toBe(true)
    expect(details[1].open).toBe(false)
    await act(() => toggle.click())
    await act(() => toggle.click())
    expect(api.folders.trashFolders).toHaveBeenCalledTimes(1)
    expect([...container.querySelectorAll('details')].every((item) => !item.open)).toBe(true)
    expect(api.notes.get).not.toHaveBeenCalled()
  })

  it('loads only the selected note and shows its content without allowing task edits or note creation', async () => {
    await act(() => root.render(createElement(FolderTrashGroups, { groups: [group] })))
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    for (const summary of container.querySelectorAll('summary')) await act(() => summary.click())
    const noteButton = [...container.querySelectorAll('button')].find((button) => button.textContent === note.title)!
    await act(() => noteButton.click())
    expect(api.notes.get).toHaveBeenCalledExactlyOnceWith(note.id)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain(t('folders.trash_note_read_only'))
    expect(dialog.querySelector('[data-preview-content]')?.textContent).toContain('Deleted fixture')
    expect(dialog.querySelector('textarea, [contenteditable="true"]')).toBeNull()
    const checkbox = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.disabled).toBe(true)
    await act(() => checkbox.click())
    await act(() => dialog.querySelector<HTMLElement>('[data-wikilink]')!.click())
    expect(useNotes.getState().editContent).not.toHaveBeenCalled()
    expect(useNotes.getState().createNote).not.toHaveBeenCalled()
    await act(() => dialog.querySelector<HTMLButtonElement>(`button[aria-label="${t('common.close')}"]`)!.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('allows retrying a failed folder read without changing the trash group', async () => {
    vi.mocked(api.folders.trashFolders).mockRejectedValueOnce(new Error('Read failed'))
    await act(() => root.render(createElement(FolderTrashGroups, { groups: [group] })))
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Read failed')
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === t('common.retry'))!
    await act(() => retry.click())
    expect(container.querySelector('details')).not.toBeNull()
    expect(api.folders.trashFolders).toHaveBeenCalledTimes(2)
  })
})
