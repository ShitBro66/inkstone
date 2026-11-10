// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { persistAttachmentWithinQuota } from '../src/worker/attachments/storage'
import type { Env } from '../src/worker/env'

let sqlite: DatabaseSync
let env: Env
let releaseWrites: () => void
let put: ReturnType<typeof vi.fn>
let remove: ReturnType<typeof vi.fn>

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const sql of SCHEMA_STATEMENTS) sqlite.exec(sql)
  const writes = new Promise<void>((resolve) => { releaseWrites = resolve })
  put = vi.fn(async () => { await writes })
  remove = vi.fn(async () => {})
  const prepare = (sql: string, values: unknown[] = []) => {
    const bindings = () => Object.fromEntries([...new Set([...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])))].map((number) => ['?' + number, values[number - 1]]))
    return {
      bind: (...parameters: unknown[]) => prepare(sql, parameters),
      first: async () => sqlite.prepare(sql).get(bindings() as never) ?? null,
      run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(bindings() as never).changes) } }),
    }
  }
  env = { DB: { prepare }, FILES: { put, delete: remove } } as unknown as Env
})

afterEach(() => { releaseWrites(); sqlite.close() })

async function finishThreeUploads() {
  const uploads = Promise.allSettled([1, 2, 3].map((index) => persistAttachmentWithinQuota(env, {
    id: String(index).padStart(26, '0'), userId: 'owner', noteId: null,
    filename: `image-${index}.jpg`, reportedMime: 'application/octet-stream', bytes: new Uint8Array(10), createdAt: 1,
  })))
  try {
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(3))
  } finally {
    releaseWrites()
  }
  return uploads
}

it('allows three uploads to finish concurrently for the same account', async () => {
  const uploads = await finishThreeUploads()
  expect(uploads.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM attachments').get()!.n).toBe(3)
  expect(remove).not.toHaveBeenCalled()
})

it('atomically enforces quota and removes objects rejected at insertion', async () => {
  sqlite.prepare(`INSERT INTO attachments (id, user_id, filename, mime, size, sha256, storage, created_at)
    VALUES ('existing', 'owner', 'existing.jpg', 'image/jpeg', ?, '', 'r2', 1)`).run(LIMITS.attachmentQuotaBytes - 15)
  const uploads = await finishThreeUploads()
  expect(uploads.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  for (const result of uploads) {
    if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 413, code: 'payload_too_large' })
  }
  expect(sqlite.prepare('SELECT SUM(size) AS bytes FROM attachments').get()!.bytes).toBeLessThanOrEqual(LIMITS.attachmentQuotaBytes)
  expect(remove).toHaveBeenCalledTimes(2)
})
