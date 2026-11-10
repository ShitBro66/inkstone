// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { settingsRoutes } from '../src/worker/routes/settings'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: AppBindings['Bindings']
let userId: string
let owner: boolean

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const prepare = (sql: string, values: unknown[] = []) => {
    const args = () => Object.fromEntries(values.map((value, i) => ['?' + (i + 1), value]))
    return {
      bind: (...parameters: unknown[]) => prepare(sql, parameters),
      first: async () => sqlite.prepare(sql).get(args() as never) ?? null,
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(args() as never).changes) } }),
    }
  }
  env = { DB: { prepare, batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
    const results = []; for (const statement of statements) results.push(await statement.run()); return results
  } } } as unknown as AppBindings['Bindings']
  userId = 'owner'; owner = true
  app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('user', { id: userId, role: owner ? 'owner' : 'member', username: userId, name: userId, login: userId, avatarUrl: '', createdAt: 1, settingsRaw: '{}' })
    await next()
  })
  app.onError((error, c) => errorResponse(c, error))
  app.route('/api/settings', settingsRoutes)
})
afterEach(() => sqlite.close())

const read = async () => (await app.request('/api/settings/uploads', {}, env)).json()
const save = (concurrency: number, syncToAll: boolean) => app.request('/api/settings/uploads', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concurrency, syncToAll }),
}, env)

it('defaults to one, follows the owner for old and new accounts, and restores private settings on revoke', async () => {
  expect(await read()).toEqual({ concurrency: 1, syncToAll: false })
  expect((await save(3, false)).status).toBe(200)
  userId = 'existing-member'; owner = false
  expect(await read()).toEqual({ concurrency: 1, syncToAll: false })
  userId = 'owner'; owner = true
  await save(3, true)
  for (const account of ['existing-member', 'new-member']) {
    userId = account; owner = false
    expect(await read()).toEqual({ concurrency: 3, syncToAll: true })
  }
  userId = 'owner'; owner = true
  await save(5, true)
  userId = 'new-member'; owner = false
  expect(await read()).toEqual({ concurrency: 5, syncToAll: true })
  userId = 'owner'; owner = true
  await save(5, false)
  expect(await read()).toEqual({ concurrency: 5, syncToAll: false })
  userId = 'existing-member'; owner = false
  expect(await read()).toEqual({ concurrency: 1, syncToAll: false })
})

it('rejects member writes and invalid concurrency', async () => {
  owner = false
  expect((await save(4, true)).status).toBe(403)
  owner = true
  for (const value of [0, -1, 1.5]) expect((await save(value, false)).status).toBe(400)
  expect(await read()).toEqual({ concurrency: 1, syncToAll: false })
})
