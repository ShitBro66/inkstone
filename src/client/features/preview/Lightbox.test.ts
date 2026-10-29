import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { Lightbox } from './Lightbox'

let root: Root
let host: HTMLDivElement
let image: HTMLImageElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await initI18n()
  useUi.getState().setLightbox({ src: 'https://images.example.test/first.png', alt: 'Fixture' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(createElement(Lightbox)) })
  image = document.querySelector<HTMLImageElement>('[role="dialog"] img')!
  const captured = new Set<number>()
  Object.defineProperties(image, {
    setPointerCapture: { value: vi.fn((id: number) => captured.add(id)) },
    hasPointerCapture: { value: (id: number) => captured.has(id) },
    releasePointerCapture: { value: vi.fn((id: number) => captured.delete(id)) },
  })
})

afterEach(async () => {
  await act(() => root.unmount())
  host.remove()
  useUi.getState().setLightbox(null)
  vi.unstubAllGlobals()
})

function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  image.dispatchEvent(event)
}

async function zoomIn() {
  await act(() => document.querySelector<HTMLButtonElement>(`button[aria-label="${t('common.zoom_in')}"]`)!.click())
}

it('zooms in and out with the wheel without modifier keys', async () => {
  const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -250 })
  await act(() => image.dispatchEvent(wheel))
  expect(wheel.defaultPrevented).toBe(true)
  expect(image.style.transform).toBe('scale(1.5)')
  await act(() => image.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 250 })))
  expect(image.style.transform).toBe('scale(1)')
})

it('drags an enlarged image and continues from its previous position', async () => {
  await zoomIn()
  expect(image.draggable).toBe(false)
  await act(() => pointer('pointerdown', 100, 80))
  expect(image.setPointerCapture).toHaveBeenCalledWith(1)
  await act(() => pointer('pointermove', 220, 150))
  expect(image.style.translate).toBe('120px 70px')
  expect(image.style.transitionDuration).toBe('0ms')
  await act(() => pointer('pointerup', 220, 150))
  expect(image.releasePointerCapture).toHaveBeenCalledWith(1)

  await act(() => pointer('pointerdown', 220, 150))
  await act(() => pointer('pointermove', 170, 130))
  await act(() => pointer('pointerup', 170, 130))
  expect(image.style.translate).toBe('70px 50px')
  await act(() => image.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

it.each(['pointercancel', 'lostpointercapture'])('stops dragging on %s', async (event) => {
  await zoomIn()
  await act(() => pointer('pointerdown', 100, 80))
  await act(() => pointer('pointermove', 150, 100))
  await act(() => pointer(event, 150, 100))
  await act(() => pointer('pointermove', 300, 200))
  expect(image.style.translate).toBe('50px 20px')
  expect(image.style.transitionDuration).not.toBe('0ms')
})

it('recenters at the original size and ignores dragging before zooming in', async () => {
  await zoomIn()
  await act(() => pointer('pointerdown', 100, 80))
  await act(() => pointer('pointermove', 200, 120))
  await act(() => pointer('pointerup', 200, 120))
  await act(() => document.querySelector<HTMLButtonElement>(`button[aria-label="${t('common.zoom_out')}"]`)!.click())
  expect(image.style.translate).toBe('0px 0px')
  await act(() => pointer('pointerdown', 100, 80))
  await act(() => pointer('pointermove', 200, 120))
  expect(image.style.translate).toBe('0px 0px')
})

it('resets zoom and position when displaying another image', async () => {
  await zoomIn()
  await act(() => pointer('pointerdown', 100, 80))
  await act(() => pointer('pointermove', 200, 120))
  await act(() => useUi.getState().setLightbox({ src: 'https://images.example.test/second.png', alt: 'Second' }))
  expect(image.src).toBe('https://images.example.test/second.png')
  expect(image.style.transform).toBe('scale(1)')
  expect(image.style.translate).toBe('0px 0px')
})
