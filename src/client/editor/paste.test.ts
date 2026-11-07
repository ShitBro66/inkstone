import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '../lib/i18n';
import { insertFiles, pasteExtension, type PasteHandlers } from './paste';

const first = new File(['first'], 'first.png', { type: 'image/png' });
const second = new File(['second'], 'second.png', { type: 'image/png' });
const result = (file: File) => ({ url: '/api/files/' + file.name, filename: file.name, isImage: true });
type Upload = Parameters<PasteHandlers['uploadFile']>[1];
type UploadResult = Awaited<ReturnType<PasteHandlers['uploadFile']>>;
let view: EditorView;

beforeEach(async () => { await initI18n(); });
afterEach(() => view?.destroy());

function editor(handlers: PasteHandlers, doc = '') {
    view = new EditorView({ parent: document.body, state: EditorState.create({ doc, extensions: [pasteExtension(handlers)] }) });
}

function paste(files: File[], items: File[]) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
        files,
        types: ['Files', 'text/html'],
        items: items.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        getData: (type: string) => type === 'text/html' ? '<p>Other clipboard content</p>' : '',
    } });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
}

function pendingUploads() {
    const pending = new Map<File, Upload & { resolve: (value: UploadResult) => void }>();
    const uploadFile = vi.fn((file: File, upload: Upload) => new Promise<UploadResult>((resolve) => {
        pending.set(file, { ...upload, resolve });
    }));
    return { pending, uploadFile };
}

it.each([0, 1, 2])('pastes all clipboard images once when FileList contains %i of them', async (listed) => {
    const { pending, uploadFile } = pendingUploads();
    editor({ uploadFile });
    paste([first, second].slice(0, listed), [first, second]);
    expect(uploadFile.mock.calls.map(([file]) => file)).toEqual([first, second]);
    pending.get(second)!.resolve(result(second));
    pending.get(first)!.resolve(result(first));
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe('![first](</api/files/first.png>)\n![second](</api/files/second.png>)'));
});

it('removes a cancelled image immediately and still inserts the other image', async () => {
    const { pending, uploadFile } = pendingUploads();
    editor({ uploadFile }, 'Existing text');
    const batch = insertFiles(view, [first, second], { uploadFile });
    const cancelled = pending.get(first)!;
    cancelled.cancel();
    expect(cancelled.signal.aborted).toBe(true);
    expect(view.state.doc.toString()).not.toContain('first.png');
    expect(pending.get(second)!.signal.aborted).toBe(false);
    cancelled.resolve(result(first));
    pending.get(second)!.resolve(result(second));
    await batch;
    expect(view.state.doc.toString()).toBe('![second](</api/files/second.png>)Existing text');
});

it('removes the placeholder in the original note after its editor is detached', async () => {
    const { pending, uploadFile } = pendingUploads();
    const replaceDetachedUpload = vi.fn();
    editor({ uploadFile, replaceDetachedUpload });
    const batch = insertFiles(view, [first], { uploadFile, replaceDetachedUpload });
    const placeholder = view.state.doc.toString();
    view.dom.remove();
    pending.get(first)!.cancel();
    pending.get(first)!.resolve(result(first));
    await batch;
    expect(replaceDetachedUpload).toHaveBeenCalledExactlyOnceWith(placeholder, '');
});
