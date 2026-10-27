import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { mergeSettings, mergeSettingsPatch } from '@shared/constants'
import { initI18n, t } from '../../lib/i18n'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { useSession } from '../../store/session'
import { Preview } from '../preview/Preview'
import { EditorSettings } from './EditorSettings'

it('defaults to strict line breaks and preserves the explicit choice when merging settings', () => {
  expect(mergeSettings({}).preview.strictLineBreaks).toBe(true)
  const saved = mergeSettingsPatch(mergeSettings({}), { preview: { strictLineBreaks: false } })
  expect(mergeSettings(JSON.parse(JSON.stringify(saved))).preview.strictLineBreaks).toBe(false)
  expect(mergeSettingsPatch(saved, { editor: { spellcheck: true } }).preview.strictLineBreaks).toBe(false)
})

it('keeps explicit line breaks, paragraphs and fenced code intact in both modes', () => {
  for (const strict of [true, false]) {
    const explicit = renderMarkdown('First\\\nSecond', strict).html
    expect(explicit).toContain('<br>')
    expect(renderMarkdown('First\n\nSecond', strict).html.match(/<p\b/g)).toHaveLength(2)
    expect(renderMarkdown('```text\nFirst\nSecond\n```', strict).html).not.toContain('<br>')
  }
  expect(renderMarkdown('First\nSecond', true).html).not.toContain('<br>')
  expect(renderMarkdown('First\nSecond', false).html).toContain('<br>')
  expect(renderMarkdown('First\nSecond', true).html).not.toContain('<br>')
})

it('toggles the setting and updates the existing preview without changing the source', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await initI18n()
  const previous = useSession.getState()
  const updateSettings = vi.fn(async (patch) => {
    useSession.setState({ settings: mergeSettingsPatch(useSession.getState().settings, patch) })
  })
  useSession.setState({ settings: mergeSettings({}), updateSettings })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const source = 'First\nSecond'
  try {
    await act(() => root.render(createElement('div', null,
      createElement(EditorSettings), createElement(Preview, { content: source }),
    )))
    const toggle = host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${t('settings.strict_line_breaks')}"]`)!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[data-preview-content] br')).toBeNull()
    await act(() => toggle.click())
    expect(updateSettings).toHaveBeenCalledWith({ preview: { strictLineBreaks: false } })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(host.querySelector('[data-preview-content] br')).not.toBeNull()
    await act(() => toggle.click())
    expect(host.querySelector('[data-preview-content] br')).toBeNull()
    expect(source).toBe('First\nSecond')
  } finally {
    await act(() => root.unmount())
    host.remove()
    useSession.setState(previous)
    vi.unstubAllGlobals()
  }
})
