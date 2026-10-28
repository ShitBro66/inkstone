import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shareRoutes } from '../src/worker/routes/share'
import type { AppBindings } from '../src/worker/env'

vi.mock('../src/worker/lib/password', () => ({
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(async (password: string) => password === 'correct'),
}))
vi.mock('../src/worker/lib/share-asset-session', () => ({
  createShareAssetSession: vi.fn(async () => 'fixture-session'),
  shareAssetCookieName: vi.fn(() => 'fixture-share'),
}))
vi.mock('../src/worker/lib/throttle', () => ({
  assertNotLocked: vi.fn(async () => {}), clearLoginFailures: vi.fn(async () => {}),
  consumeAttemptBudget: vi.fn(async () => {}), recordLoginFailure: vi.fn(async () => {}),
  ThrottleError: class extends Error {},
}))

const slug = '0123456789abcdefghjk'
let db: DatabaseSync
let app: Hono<AppBindings>
let env: AppBindings['Bindings']

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE users (id TEXT, name TEXT, avatar_url TEXT, settings TEXT);
    CREATE TABLE notes (id TEXT, user_id TEXT, title TEXT, content TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
    CREATE TABLE shares (slug TEXT, note_id TEXT, user_id TEXT, password_hash TEXT, expires_at INTEGER, views INTEGER, created_at INTEGER);`)
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('owner', 'Fixture owner', '', '{}')
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('other', 'Other', '', '{"preview":{"strictLineBreaks":true}}')
  db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?)').run('fixture-note', 'owner', 'Fixture', 'First\nSecond', 1, 1, null)
  db.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?, ?, ?)').run(slug, 'fixture-note', 'owner', null, null, 0, 1)
  const prepare = (sql: string, values: unknown[] = []) => ({
    bind: (...parameters: unknown[]) => prepare(sql, parameters),
    first: async () => db.prepare(sql).get(...values as never[]) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...values as never[]).changes) } }),
  })
  env = { DB: { prepare }, APP_NAME: 'Fixture' } as unknown as AppBindings['Bindings']
  app = new Hono<AppBindings>()
  app.route('/api/public', shareRoutes)
})
afterEach(() => db.close())

function read(password?: string) {
  return app.fetch(new Request(`https://example.test/api/public/${slug}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  }), env, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext)
}

describe('shared note line breaks', () => {
  it('uses the note owner setting, including its default, and returns no other settings', async () => {
    let result = await (await read()).json() as Record<string, unknown>
    expect(result.strictLineBreaks).toBe(true)
    db.prepare('UPDATE users SET settings = ? WHERE id = ?').run('{"preview":{"strictLineBreaks":false},"privateValue":"fixture-secret"}', 'owner')
    result = await (await read()).json() as Record<string, unknown>
    expect(result.strictLineBreaks).toBe(false)
    expect(result.content).toBe('First\nSecond')
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
    db.prepare('UPDATE users SET settings = ? WHERE id = ?').run('{"preview":{"strictLineBreaks":true}}', 'owner')
    expect((await (await read()).json() as Record<string, unknown>).strictLineBreaks).toBe(true)
  })

  it('does not expose the setting before a protected share is unlocked', async () => {
    db.prepare('UPDATE shares SET password_hash = ? WHERE slug = ?').run('fixture-hash', slug)
    const locked = await read()
    expect(locked.status).toBe(401)
    expect(await locked.json()).not.toHaveProperty('strictLineBreaks')
    expect((await read('incorrect')).status).toBe(401)
    const unlocked = await read('correct')
    expect(unlocked.status).toBe(200)
    expect((await unlocked.json() as Record<string, unknown>).strictLineBreaks).toBe(true)
  })
})
