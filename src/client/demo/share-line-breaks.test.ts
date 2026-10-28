import { expect, it } from 'vitest'
import { createDemoBackend } from './backend'
import { DEMO_CREDENTIALS } from '../lib/runtime'

it('returns the current demo author setting on an existing public share', async () => {
  const backend = createDemoBackend()
  async function request(method: string, path: string, body: unknown) {
    const response = await backend.fetch(new Request('https://demo.invalid' + path, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    expect(response.status).toBeLessThan(400)
    return response.json()
  }
  await request('POST', '/api/auth/login', DEMO_CREDENTIALS)
  expect((await request('POST', '/api/public/welcome', {})).strictLineBreaks).toBe(true)
  await request('PUT', '/api/settings', { preview: { strictLineBreaks: false } })
  expect((await request('POST', '/api/public/welcome', {})).strictLineBreaks).toBe(false)
})
