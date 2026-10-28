import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { PublicNote } from '@shared/types'
import { api } from '../../lib/api'
import { initI18n } from '../../lib/i18n'
import { SharePage } from './SharePage'

it.each([true, false])('renders a public note using the author setting (strict: %s)', async (strictLineBreaks) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await initI18n()
  const note: PublicNote = {
    title: 'Fixture', content: 'First\nSecond', strictLineBreaks, createdAt: 1, updatedAt: 1,
    author: { name: 'Fixture', avatarUrl: '' }, site: { name: 'Fixture' }, share: { slug: 'fixture' },
  }
  vi.spyOn(api.share, 'read').mockResolvedValue(note)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(createElement(SharePage, { slug: 'fixture' })) })
    const content = host.querySelector('.ink-prose')!
    expect(content.textContent).toContain('First')
    expect(content.textContent).toContain('Second')
    expect(content.querySelectorAll('br')).toHaveLength(strictLineBreaks ? 0 : 1)
  } finally {
    await act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
