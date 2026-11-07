import { useRef, useState } from 'react';
import { Archive, Columns2, FileText, FolderInput, MoreHorizontal, Star, Trash2 } from 'lucide-react';
import type { Folder, NoteSummary } from '@shared/types';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { IconButton } from '../../components/primitives';
import { Menu, useContextMenu, type MenuItem } from '../../components/overlay';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { FolderPicker } from '../folders/FolderPicker';
import { leftDropTarget, useDropState } from './drag-drop';

const NOTE_DRAG_TYPE = 'application/x-inkstone-note';
// Only the type names are readable while a native drag is hovering over a target.
const TREE_NOTE_DRAG_PREFIX = 'application/x-inkstone-tree-note-';

function noteDropSide(event: React.DragEvent<HTMLDivElement>): 'before' | 'after' {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

export function groupExplorerNotes(notes: Record<string, NoteSummary>, folders: Folder[], locale: string): Map<string | null, NoteSummary[]> {
    const folderIds = new Set(folders.map((folder) => folder.id));
    const groups = new Map<string | null, NoteSummary[]>();
    for (const note of Object.values(notes)) {
        if (note.deletedAt || note.isArchived) continue;
        const parent = note.folderId && folderIds.has(note.folderId) ? note.folderId : null;
        const siblings = groups.get(parent) ?? [];
        siblings.push(note);
        groups.set(parent, siblings);
    }
    for (const [folderId, siblings] of groups) {
        siblings.sort((a, b) => {
            // Manual positions come before notes that still follow the title order.
            if (folderId !== null) {
                const positionOrder = Math.min(a.position, 0) - Math.min(b.position, 0);
                if (positionOrder !== 0) return positionOrder;
            }
            return a.title.localeCompare(b.title, locale, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id);
        });
    }
    return groups;
}

export function ExplorerNote({ note, depth, canOpenToSide, siblings }: { note: NoteSummary; depth: number; canOpenToSide: boolean; siblings?: NoteSummary[] }) {
    const active = useUi((s) => s.activeNoteId === note.id);
    const openNote = useNotes((s) => s.openNote);
    const patchNote = useNotes((s) => s.patchNote);
    const deleteNote = useNotes((s) => s.deleteNote);
    const folders = useNotes((s) => s.folders);
    const anchor = useRef<HTMLDivElement>(null);
    const contextMenu = useContextMenu();
    const [menuOpen, setMenuOpen] = useState(false);
    const [moving, setMoving] = useState(false);
    const [dropSide, setDropSide] = useDropState<'before' | 'after' | null>(null);
    const reorderFolderNotes = useNotes((s) => s.reorderFolderNotes);
    const open = (side = false) => {
        useUi.getState().openExplorer(folders.some((folder) => folder.id === note.folderId) ? note.folderId : null);
        void openNote(note.id, side ? { pane: 'secondary' } : undefined);
    };
    const items: MenuItem[] = [
        ...(canOpenToSide ? [{ id: 'side', label: t('notes.open_to_side'), icon: <Columns2 size={13}/>, onSelect: () => open(true) }] : []),
        { id: 'star', label: note.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites'), icon: <Star size={13}/>, onSelect: () => void patchNote(note.id, { isStarred: !note.isStarred }) },
        { id: 'move', label: t('notes.move_to_folder'), icon: <FolderInput size={13}/>, onSelect: () => setMoving(true) },
        { id: 'archive', label: t('navigation.archive'), icon: <Archive size={13}/>, onSelect: () => void patchNote(note.id, { isArchived: true }) },
        { id: 'delete', label: t('common.move_to_trash'), icon: <Trash2 size={13}/>, separatorBefore: true, tone: 'danger', onSelect: () => void deleteNote(note.id) },
    ];
    return <div role="treeitem" aria-level={depth + 1} aria-selected={active} data-tree-note-id={note.id}>
        <div ref={anchor} draggable data-note-drop-target={siblings ? '' : undefined} onDragStart={(event) => {
            event.dataTransfer.setData(NOTE_DRAG_TYPE, note.id);
            if (siblings) event.dataTransfer.setData(TREE_NOTE_DRAG_PREFIX + note.id, note.id);
            event.dataTransfer.effectAllowed = 'move';
        }} onDragOver={(event) => {
            if (!siblings) return;
            const sourceType = event.dataTransfer.types.find((type) => type.startsWith(TREE_NOTE_DRAG_PREFIX));
            const sourceId = sourceType?.slice(TREE_NOTE_DRAG_PREFIX.length);
            if (sourceId === note.id || !siblings.some((item) => item.id === sourceId)) {
                setDropSide(null);
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            setDropSide(noteDropSide(event));
        }} onDragLeave={(event) => {
            if (leftDropTarget(event)) setDropSide(null);
        }} onDrop={(event) => {
            if (!siblings || !event.dataTransfer.types.includes(NOTE_DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            setDropSide(null);
            const sourceId = event.dataTransfer.getData(NOTE_DRAG_TYPE);
            if (sourceId === note.id || note.folderId === null || !event.dataTransfer.types.includes(TREE_NOTE_DRAG_PREFIX + sourceId)) return;
            const noteIds = siblings.map((item) => item.id);
            const from = noteIds.indexOf(sourceId);
            if (from < 0) return;
            noteIds.splice(from, 1);
            const to = noteIds.indexOf(note.id) + (noteDropSide(event) === 'after' ? 1 : 0);
            if (from === to) return;
            noteIds.splice(to, 0, sourceId);
            void reorderFolderNotes(note.folderId, noteIds);
        }} onContextMenu={(event) => { setMenuOpen(false); contextMenu.onContextMenu(event); }} className={cn('group relative flex h-11 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[30px]', active ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')} style={{ paddingLeft: 6 + depth * 13 }}>
            {dropSide === 'before' && <span aria-hidden="true" className="pointer-events-none absolute top-0 right-1 left-1 h-px bg-[var(--accent)]"/>}
            {dropSide === 'after' && <span aria-hidden="true" className="pointer-events-none absolute right-1 bottom-0 left-1 h-px bg-[var(--accent)]"/>}
            <span className="w-8 shrink-0 md:w-4"/>
            <FileText size={14} className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}/>
            <button type="button" data-tree-note-open data-navigation-item aria-current={active ? 'page' : undefined} title={note.title || t('common.untitled_note')} onClick={() => open()} className="h-full min-w-0 flex-1 truncate pl-1 text-left text-[12.5px]">
                {note.title || t('common.untitled_note')}
            </button>
            <IconButton label={t('common.more_actions')} size="sm" onClick={() => { contextMenu.close(); setMenuOpen(true); }} className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"><MoreHorizontal size={13}/></IconButton>
        </div>
        <Menu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={items}/>
        {contextMenu.point && <Menu anchor={contextMenu.point} open onClose={contextMenu.close} items={items}/>}
        <FolderPicker open={moving} title={t('notes.move_to_folder')} folders={folders} currentId={note.folderId} onSelect={(folderId) => void patchNote(note.id, { folderId })} onClose={() => setMoving(false)}/>
    </div>;
}
