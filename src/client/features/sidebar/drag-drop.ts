import { useEffect, useState } from 'react';

export function useDropState<T>(idle: T) {
    const [state, setState] = useState(idle);
    useEffect(() => {
        if (state === idle) return;
        const reset = () => setState(idle);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') reset();
        };
        const onLeaveWindow = (event: DragEvent) => {
            if (event.target === document.documentElement && !event.relatedTarget) reset();
        };
        window.addEventListener('drop', reset, true);
        window.addEventListener('dragend', reset, true);
        window.addEventListener('blur', reset);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('dragleave', onLeaveWindow, true);
        return () => {
            window.removeEventListener('drop', reset, true);
            window.removeEventListener('dragend', reset, true);
            window.removeEventListener('blur', reset);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('dragleave', onLeaveWindow, true);
        };
    }, [state, idle]);
    return [state, setState] as const;
}
export function leftDropTarget(event: React.DragEvent<HTMLElement>): boolean {
    const next = event.relatedTarget;
    return !(next instanceof Node) || !event.currentTarget.contains(next);
}
