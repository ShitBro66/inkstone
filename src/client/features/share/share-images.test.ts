import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PublicNote } from '@shared/types'
import { api } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { SharePage } from './SharePage'

let root: Root
let host: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await initI18n()
  useUi.getState().setLightbox(null)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(() => root.unmount())
  host.remove()
  useUi.getState().setLightbox(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function renderSharedImage(src: string) {
  const note: PublicNote = {
    title: 'Fixture', content: `[![Shared image](${src})](https://example.test/original)`,
    strictLineBreaks: true, createdAt: 1, updatedAt: 1,
    author: { name: 'Fixture', avatarUrl: '' }, site: { name: 'Fixture' }, share: { slug: 'fixture' },
  }
  vi.spyOn(api.share, 'read').mockResolvedValue(note)
  await act(async () => { root.render(createElement(SharePage, { slug: 'fixture' })) })
  return host.querySelector<HTMLImageElement>('.ink-prose img')!
}

async function openImage(image: HTMLImageElement) {
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  await act(async () => {
    image.dispatchEvent(click)
    await vi.dynamicImportSettled()
  })
  expect(click.defaultPrevented).toBe(true)
  const dialog = document.querySelector<HTMLDivElement>('[role="dialog"]')!
  expect(dialog).not.toBeNull()
  return dialog
}

it.each([
  'https://images.example.test/shared.png',
  `/api/files/${'0'.repeat(26)}`,
])('opens and closes a shared image while preserving its access URL: %s', async (src) => {
  const image = await renderSharedImage(src)
  if (src.startsWith('/api/files/')) expect(image.src).toContain('?share=fixture')
  const dialog = await openImage(image)
  const preview = dialog.querySelector('img')!
  expect(preview.src).toBe(image.src)
  expect(preview.alt).toBe('Shared image')
  expect(dialog.querySelector<HTMLAnchorElement>('a[download]')!.href).toBe(image.src)

  await act(() => dialog.querySelector<HTMLButtonElement>(`button[aria-label="${t('common.zoom_in')}"]`)!.click())
  expect(preview.style.transform).toBe('scale(1.25)')
  await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()

  const reopened = await openImage(image)
  expect(reopened.querySelector('img')!.style.transform).toBe('scale(1)')
  await act(() => reopened.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('clears the image preview when leaving the share page', async () => {
  const image = await renderSharedImage('https://images.example.test/shared.png')
  await openImage(image)
  await act(() => root.render(createElement('div', null, 'Other page')))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(useUi.getState().lightbox).toBeNull()
})
