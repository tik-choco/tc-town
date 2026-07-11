// Shared VRM model library. This deliberately uses the SAME IndexedDB
// database, object store and record schema as tc-vrm-viewer
// (src/storage/library.ts + domain.ts) so that models imported in either
// app on the same origin are visible in the other. VRM bytes are stored as
// a base64 `data:` URL on the `dataUrl` field of a FileRecord, keyed by a
// generated `file-...` id, with a sha256 hex `checksum` as the stable
// cross-app identity (also referenced by VrmAvatar in types.ts).

const DB_NAME = 'tc-vrm-viewer'
const DB_VERSION = 1
const STORE_NAME = 'models'
const LIBRARY_FOLDER_ID = 'library'
const VRM_MIME_TYPE = 'model/gltf-binary'

/** The tc-vrm-viewer FileRecord shape (only the fields we read/write). */
interface FileRecord {
  id: string
  folderId: string
  sortOrder?: number
  name: string
  mimeType: string
  size: number
  dataUrl?: string
  checksum: string
  version: number
  starred: boolean
  createdAt: string
  updatedAt: string
}

/** Lightweight view of a library model, without the (large) bytes. */
export interface VrmModelInfo {
  id: string
  name: string
  checksum: string
  size: number
  createdAt: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function makeFileId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return `file-${cryptoApi.randomUUID()}`
  const bytes = new Uint8Array(8)
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  return `file-${Date.now().toString(36)}-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function toInfo(record: FileRecord): VrmModelInfo {
  return { id: record.id, name: record.name, checksum: record.checksum, size: record.size, createdAt: record.createdAt }
}

/** sha256 hex digest — identical scheme to tc-vrm-viewer's `checksumOf`. */
export async function checksumOf(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = ''
  // Chunked to avoid call-stack limits on String.fromCharCode(...spread).
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

function bytesFromDataUrl(dataUrl: string): Uint8Array {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1 || !dataUrl.slice(0, commaIndex).includes('base64')) {
    throw new Error('Unsupported dataUrl encoding (expected base64)')
  }
  const binary = atob(dataUrl.slice(commaIndex + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function getAllRecords(): Promise<FileRecord[]> {
  const db = await openDb()
  try {
    return await new Promise<FileRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).getAll()
      request.onsuccess = () => resolve(request.result as FileRecord[])
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function getRecord(id: string): Promise<FileRecord | undefined> {
  const db = await openDb()
  try {
    return await new Promise<FileRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(id)
      request.onsuccess = () => resolve(request.result as FileRecord | undefined)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

/** Every model in the shared library, newest first. */
export async function listVrmModels(): Promise<VrmModelInfo[]> {
  const records = await getAllRecords()
  return records
    .filter((record) => record.folderId === LIBRARY_FOLDER_ID || Boolean(record.dataUrl))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toInfo)
}

/**
 * Import a `.vrm` File into the shared library. Computes the sha256 checksum
 * and dedupes on it: if a model with the same bytes already exists (imported
 * here or in tc-vrm-viewer) the existing record is returned unchanged.
 */
export async function importVrmFile(file: File): Promise<VrmModelInfo> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const checksum = await checksumOf(bytes)

  const existing = (await getAllRecords()).find((record) => record.checksum === checksum)
  if (existing) return toInfo(existing)

  const now = new Date().toISOString()
  const record: FileRecord = {
    id: makeFileId(),
    folderId: LIBRARY_FOLDER_ID,
    name: file.name,
    mimeType: file.type || VRM_MIME_TYPE,
    size: bytes.byteLength,
    dataUrl: bytesToDataUrl(bytes, file.type || VRM_MIME_TYPE),
    checksum,
    version: 1,
    starred: false,
    createdAt: now,
    updatedAt: now,
  }

  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
  return toInfo(record)
}

/** Raw `.vrm` bytes for a library record id, or undefined if missing. */
export async function getVrmBytes(id: string): Promise<Uint8Array | undefined> {
  const record = await getRecord(id)
  if (record?.dataUrl) return bytesFromDataUrl(record.dataUrl)
  return undefined
}

/**
 * Resolve `.vrm` bytes for a VrmAvatar. Tries the stored `blobKey` (record id)
 * first; falls back to matching on `checksum` so a model imported in the other
 * app (different record id, same bytes) still resolves.
 */
export async function getVrmBytesForAvatar(blobKey: string, checksum: string): Promise<Uint8Array | undefined> {
  const byId = await getVrmBytes(blobKey)
  if (byId) return byId
  const match = (await getAllRecords()).find((record) => record.checksum === checksum)
  if (match?.dataUrl) return bytesFromDataUrl(match.dataUrl)
  return undefined
}

/** Remove a model from the shared library. */
export async function deleteVrmModel(id: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
