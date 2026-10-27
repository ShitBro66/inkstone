import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, FileText, FolderClosed, FolderTree, RotateCcw } from 'lucide-react'
import type { Folder, FolderTrashGroup, Note, NoteSummary } from '@shared/types'
import { useNotes } from '../../store/notes'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { confirm, Drawer } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { Preview } from '../preview/Preview'

export function FolderTrashGroups({ groups }: { groups: FolderTrashGroup[] }) {
  const restore = useNotes((state) => state.restoreFolderTrash)
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<NoteSummary | null>(null)
  const busyRef = useRef(false)
  const restoreGroup = async (group: FolderTrashGroup) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(group.id)
    try {
      const ok = await confirm({
        title: t('folders.restore_group_title', { name: group.rootFolder.name }),
        description: t('folders.restore_group_description'),
        confirmLabel: t('common.restore'),
      })
      if (ok) await restore(group.id)
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }
  return <>
    <div role="group" aria-label={t('folders.deleted_groups')} className="mb-3 space-y-1">
      {groups.map((group) => <FolderTrashItem key={group.id} group={group} onOpen={setSelected}>
        <button type="button" disabled={busy !== null} aria-busy={busy === group.id} aria-label={t('folders.restore_group_title', { name: group.rootFolder.name })} onClick={() => void restoreGroup(group)} className="mr-2 inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11.5px] text-[var(--accent)] hover:bg-[var(--bg-hover)] disabled:opacity-50">
          <RotateCcw size={13} />{t('common.restore')}
        </button>
      </FolderTrashItem>)}
    </div>
    {selected && groups.some((group) => group.noteIds.includes(selected.id)) && <TrashNotePreview key={selected.id} note={selected} onClose={() => setSelected(null)} />}
  </>
}

function FolderTrashItem({ group, onOpen, children }: {
  group: FolderTrashGroup
  onOpen: (note: NoteSummary) => void
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const [folders, setFolders] = useState<Folder[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const contentsId = useId()
  const allNotes = useNotes((state) => state.notes)
  const notes = group.noteIds.flatMap((id) => allNotes[id] ? [allNotes[id]] : [])
  useEffect(() => {
    if (!expanded || folders) return
    let canceled = false
    setError(null)
    api.folders.trashFolders(group.id).then((result) => {
      if (!canceled) setFolders(result.folders)
    }).catch((cause) => {
      if (!canceled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { canceled = true }
  }, [expanded, folders, group.id, attempt])
  return <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
    <div className="flex items-center">
      <button type="button" aria-expanded={expanded} aria-controls={contentsId} onClick={() => setExpanded(!expanded)} className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2.5 text-left hover:bg-[var(--bg-hover)]">
        <ChevronRight size={12} className={expanded ? 'shrink-0 rotate-90' : 'shrink-0'} />
        <FolderTree size={18} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-[var(--text-primary)]">{group.rootFolder.name}</span>
          <span className="mt-0.5 block text-[11px] text-[var(--text-tertiary)]">{t('folders.trash_group_summary', { folders: group.folderCount, notes: group.noteIds.length })}</span>
        </span>
      </button>
      {children}
    </div>
    {expanded && <div id={contentsId} className="border-t border-[var(--border-subtle)] px-2 py-1.5">
      {error ? <div role="status" className="px-2 py-1 text-[12px] text-[var(--text-tertiary)]">{error}<Button size="sm" variant="ghost" onClick={() => setAttempt(attempt + 1)}>{t('common.retry')}</Button></div>
        : folders === null ? <p role="status" className="px-2 py-1 text-[12px] text-[var(--text-tertiary)]">{t('common.loading')}</p>
          : <TrashFolderContents folderId={group.rootFolder.id} folders={folders} notes={notes} onOpen={onOpen} />}
    </div>}
  </div>
}

function TrashFolderContents({ folderId, folders, notes, onOpen }: {
  folderId: string
  folders: Folder[]
  notes: NoteSummary[]
  onOpen: (note: NoteSummary) => void
}) {
  return <ul className="space-y-0.5">
    {folders.filter((folder) => folder.parentId === folderId).map((folder) => <li key={folder.id}>
      <details className="[&[open]>summary>svg:first-child]:rotate-90">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] [&::-webkit-details-marker]:hidden">
          <ChevronRight size={12} className="shrink-0" /><FolderClosed size={14} className="shrink-0" /><span className="truncate">{folder.name}</span>
        </summary>
        <div className="ml-3 border-l border-[var(--border-subtle)] pl-2">
          <TrashFolderContents folderId={folder.id} folders={folders} notes={notes} onOpen={onOpen} />
        </div>
      </details>
    </li>)}
    {notes.filter((note) => note.folderId === folderId).map((note) => <li key={note.id}>
      <button type="button" onClick={() => onOpen(note)} className="flex w-full items-center gap-1.5 rounded px-1 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
        <FileText size={14} className="ml-3 shrink-0 text-[var(--text-tertiary)]" /><span className="truncate">{note.title || t('common.untitled_note')}</span>
      </button>
    </li>)}
  </ul>
}

function TrashNotePreview({ note, onClose }: { note: NoteSummary; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Note | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let canceled = false
    setError(null)
    api.notes.get(note.id).then((result) => {
      if (!canceled) setLoaded(result)
    }).catch((cause) => {
      if (!canceled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { canceled = true }
  }, [note.id, attempt])
  return <Drawer open onClose={onClose} width={840} title={<span className="block max-w-[min(700px,75vw)] truncate">{note.title || t('common.untitled_note')}</span>}>
    <div className="flex h-full min-h-0 flex-col">
      <p className="shrink-0 border-b border-[var(--border-subtle)] px-4 py-2 text-[12px] text-[var(--text-tertiary)]">{t('folders.trash_note_read_only')}</p>
      {error ? <div role="status" className="px-4 py-3 text-[12px]">{error}<Button size="sm" variant="ghost" onClick={() => setAttempt(attempt + 1)}>{t('common.retry')}</Button></div>
        : loaded === null ? <p role="status" className="px-4 py-3 text-[12px]">{t('common.loading')}</p>
          : <div className="min-h-0 flex-1"><Preview key={loaded.id} content={loaded.content} noteId={loaded.id} noteTitle={loaded.title} readOnly /></div>}
    </div>
  </Drawer>
}
