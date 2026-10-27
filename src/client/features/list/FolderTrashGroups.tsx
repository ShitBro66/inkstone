import { useRef, useState } from 'react'
import { FolderTree, RotateCcw } from 'lucide-react'
import type { FolderTrashGroup } from '@shared/types'
import { useNotes } from '../../store/notes'
import { t } from '../../lib/i18n'
import { confirm } from '../../components/overlay'

export function FolderTrashGroups({ groups }: { groups: FolderTrashGroup[] }) {
  const restore = useNotes((state) => state.restoreFolderTrash)
  const [busy, setBusy] = useState<string | null>(null)
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
  return <div role="group" aria-label={t('folders.deleted_groups')} className="mb-3 space-y-1">
    {groups.map((group) => <div key={group.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2.5">
      <FolderTree size={18} className="shrink-0 text-[var(--text-tertiary)]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{group.rootFolder.name}</div>
        <div className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">{t('folders.trash_group_summary', { folders: group.folderCount, notes: group.noteIds.length })}</div>
      </div>
      <button type="button" disabled={busy !== null} aria-busy={busy === group.id} aria-label={t('folders.restore_group_title', { name: group.rootFolder.name })} onClick={() => void restoreGroup(group)} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11.5px] text-[var(--accent)] hover:bg-[var(--bg-hover)] disabled:opacity-50">
        <RotateCcw size={13} />{t('common.restore')}
      </button>
    </div>)}
  </div>
}
