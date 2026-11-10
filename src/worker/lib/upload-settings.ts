import { getMeta } from '../db/metadata'
import type { UploadSettings } from '@shared/types'

export const UPLOAD_SYNC_OWNER_KEY = 'setting:upload-sync-owner'
export const uploadConcurrencyKey = (userId: string) => `setting:upload-concurrency:${userId}`

export async function getUploadSettings(db: D1Database, userId: string): Promise<UploadSettings> {
  const ownerId = await getMeta(db, UPLOAD_SYNC_OWNER_KEY)
  const raw = await getMeta(db, uploadConcurrencyKey(ownerId ?? userId))
  return { concurrency: raw === null ? 1 : Number(raw), syncToAll: ownerId !== null }
}
