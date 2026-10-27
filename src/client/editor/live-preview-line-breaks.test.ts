import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { expect, it, vi } from 'vitest'
import { mergeSettings, mergeSettingsPatch } from '@shared/constants'
import { initI18n } from '../lib/i18n'
import { renderMarkdown, renderMarkdownBlocks } from '../lib/markdown/renderer'
import { useSession } from '../store/session'
import { livePreview } from './live-preview'

it.each([true, false])('keeps live blocks consistent with the preview and refreshes when strict line breaks change (initial: %s)', async (strictLineBreaks) => {
  await initI18n()
  const previous = useSession.getState()
  const clientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
  const boundingRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
  useSession.setState({ settings: mergeSettings({ preview: { strictLineBreaks } }) })
  const source = 'Label:\nhttps://example.com\n\nTail'
  const view = new EditorView({ parent: document.body, state: EditorState.create({
    doc: source, extensions: [livePreview(() => {})],
  }) })
  const expectedBreaks = strictLineBreaks ? 0 : 1
  try {
    expect(renderMarkdownBlocks(source, strictLineBreaks).blocks.map((block) => block.html).join('')).toBe(renderMarkdown(source, strictLineBreaks).html)
    expect(view.dom.querySelectorAll('.cm-live-block br')).toHaveLength(expectedBreaks)
    useSession.setState({ settings: mergeSettingsPatch(useSession.getState().settings, { preview: { strictLineBreaks: !strictLineBreaks } }) })
    await vi.waitFor(() => expect(view.dom.querySelectorAll('.cm-live-block br')).toHaveLength(expectedBreaks ? 0 : 1))
    expect(view.state.doc.toString()).toBe(source)
  } finally {
    view.destroy()
    view.dom.remove()
    useSession.setState(previous)
    if (clientRects) Object.defineProperty(Range.prototype, 'getClientRects', clientRects)
    else Reflect.deleteProperty(Range.prototype, 'getClientRects')
    if (boundingRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', boundingRect)
    else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    vi.unstubAllGlobals()
  }
})
