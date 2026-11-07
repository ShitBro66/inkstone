import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from './api'
import { initI18n } from './i18n'

class UploadRequest {
  static current: UploadRequest
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
  open = vi.fn()
  setRequestHeader = vi.fn()
  send = vi.fn<(form: FormData) => void>()
  abort = vi.fn(() => this.onabort?.())
  onabort: (() => void) | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  status = 201
  responseText = ''
  getResponseHeader = () => 'application/json'

  constructor() { UploadRequest.current = this }
}

const file = new File(['image'], 'example.png', { type: 'image/png' })

beforeEach(async () => {
  vi.stubGlobal('XMLHttpRequest', UploadRequest)
  await initI18n()
})
afterEach(() => vi.unstubAllGlobals())

it('reports upload progress and aborts only its own multipart request', async () => {
  const controller = new AbortController()
  const onUploadProgress = vi.fn()
  const pending = api.files.upload(file, 'current-note', { signal: controller.signal, onUploadProgress })
  const request = UploadRequest.current
  expect(request.open).toHaveBeenCalledExactlyOnceWith('POST', '/api/files')
  expect(request.setRequestHeader).toHaveBeenCalledWith('X-Inkstone-Client', '1')
  const form = request.send.mock.calls[0]![0]
  expect((form.get('file') as File).name).toBe(file.name)
  expect(form.get('noteId')).toBe('current-note')
  request.upload.onprogress?.(new ProgressEvent('progress', { lengthComputable: true, loaded: 2, total: 5 }))
  expect(onUploadProgress).toHaveBeenCalledExactlyOnceWith(40)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  expect(request.abort).toHaveBeenCalledOnce()
})

it('preserves the attachment response and existing API error parsing', async () => {
  const options = { onUploadProgress: vi.fn() }
  const pending = api.files.upload(file, 'current-note', options)
  const attachment = { id: 'file-id', noteId: 'current-note', filename: file.name, mime: file.type, size: file.size, width: 1, height: 1, url: '/api/files/file-id', createdAt: 1 }
  UploadRequest.current.responseText = JSON.stringify(attachment)
  UploadRequest.current.onload?.()
  await expect(pending).resolves.toEqual(attachment)

  const failed = api.files.upload(file, 'current-note', options)
  UploadRequest.current.status = 429
  UploadRequest.current.responseText = JSON.stringify({ error: { code: 'too_many_attempts', message: 'Too many uploads', details: { retryAfter: 10 } } })
  UploadRequest.current.onload?.()
  await expect(failed).rejects.toMatchObject({ status: 429, code: 'too_many_attempts', details: { retryAfter: 10 } })
})
