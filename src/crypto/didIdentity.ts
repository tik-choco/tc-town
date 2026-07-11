// Copied verbatim from tc-storage/src/crypto/didIdentity.ts (WebCrypto
// Ed25519 + did:key derivation + base58btc + localStorage persistence) so
// the tik-choco apps share one identity implementation until it is
// extracted into a common package. Do not modify the logic here
// independently of the tc-storage source.
//
// The only intentional deviation is `identityKey`: it is namespaced per app
// (tc-town vs tc-storage, tc-chat, ...) so the apps never read or clobber
// each other's persisted private key when run against the same
// origin/profile. The stored JSON schema itself is unchanged.
//
// ensureSharedDidIdentity() additionally adopts the shared cross-app DID
// (see tc-vrm-viewer's src/profile/didIdentity.ts, the canonical shared
// implementation): the identity record's mistlib storage CID is kept in the
// non app-namespaced `tc-shared-did-identity-cid-v1` localStorage key, so
// every tc-* app deployed under the same origin converges on one DID.
// tc-town prefers the shared identity when present; otherwise it promotes
// its local identity to the shared store.
import { base64ToBytes, bytesToBase64, concatBytes, toArrayBuffer } from './cryptoEncoding'

export type PublicDidIdentity = {
  did: string
  method: 'did:key'
  keyType: 'Ed25519'
  publicKeyMultibase: string
  createdAt: string
}

export type DidIdentity = PublicDidIdentity & {
  privateKeyPkcs8: string
}

type JsonStorage = Pick<Storage, 'getItem' | 'setItem'>

export type SharedStorageBackend = {
  store(bytes: Uint8Array): Promise<string>
  retrieve(cid: string): Promise<Uint8Array | undefined>
}

const identityKey = 'tc-town-did-identity-v1'
/** Shared (non app-namespaced) localStorage key pointing at the identity record's mistlib storage CID. */
const sharedIdentityCidKey = 'tc-shared-did-identity-cid-v1'
const jsonEncoder = new TextEncoder()
const jsonDecoder = new TextDecoder()
const ed25519Algorithm = { name: 'Ed25519' }
const ed25519PublicKeyMulticodec = new Uint8Array([0xed, 0x01])
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const encoder = new TextEncoder()

export function loadStoredDidIdentity(storage: JsonStorage = localStorage): DidIdentity | undefined {
  try {
    const parsed = JSON.parse(storage.getItem(identityKey) ?? '') as Partial<DidIdentity>
    if (
      parsed.method === 'did:key' &&
      parsed.keyType === 'Ed25519' &&
      typeof parsed.did === 'string' &&
      typeof parsed.publicKeyMultibase === 'string' &&
      typeof parsed.privateKeyPkcs8 === 'string' &&
      parsed.did === didKeyFromPublicKeyMultibase(parsed.publicKeyMultibase)
    ) {
      return {
        did: parsed.did,
        method: parsed.method,
        keyType: parsed.keyType,
        publicKeyMultibase: parsed.publicKeyMultibase,
        privateKeyPkcs8: parsed.privateKeyPkcs8,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      }
    }
  } catch {
    // Ignore invalid or older identity payloads and mint a fresh DID when needed.
  }
  return undefined
}

export async function ensureDidIdentity(storage: JsonStorage = localStorage): Promise<DidIdentity> {
  const stored = loadStoredDidIdentity(storage)
  if (stored) return stored
  const identity = await createDidIdentity()
  storage.setItem(identityKey, JSON.stringify(identity))
  return identity
}

/**
 * Resolves the shared cross-app DID identity: the shared mistlib storage
 * record first (via its CID pointer), then this app's local mirror
 * (promoted to the shared store), then a freshly minted identity. Persists
 * the result back to the local mirror so `ensureDidIdentity()` callers
 * elsewhere in the app converge on it. Never throws: backend failures fall
 * back to the local-only behavior of `ensureDidIdentity()`.
 */
export async function ensureSharedDidIdentity(
  options: { backend?: SharedStorageBackend; storage?: JsonStorage } = {},
): Promise<DidIdentity> {
  const storage = options.storage ?? localStorage
  const backend = options.backend

  if (backend) {
    try {
      const fromShared = await readIdentityViaBackend(backend, storage)
      if (fromShared) {
        storage.setItem(identityKey, JSON.stringify(fromShared))
        return fromShared
      }

      const local = loadStoredDidIdentity(storage)
      const identity = local ?? (await createDidIdentity())
      await writeIdentityViaBackend(backend, storage, identity)
      storage.setItem(identityKey, JSON.stringify(identity))
      return identity
    } catch {
      // Shared store unreachable or corrupt; fall through to local-only behavior.
    }
  }

  return ensureDidIdentity(storage)
}

async function readIdentityViaBackend(backend: SharedStorageBackend, storage: JsonStorage): Promise<DidIdentity | undefined> {
  const cid = storage.getItem(sharedIdentityCidKey)?.trim()
  if (!cid) return undefined
  const bytes = await backend.retrieve(cid)
  if (!bytes) return undefined
  return loadStoredDidIdentity({ getItem: () => jsonDecoder.decode(bytes), setItem: () => {} })
}

async function writeIdentityViaBackend(backend: SharedStorageBackend, storage: JsonStorage, identity: DidIdentity): Promise<void> {
  const cid = await backend.store(jsonEncoder.encode(JSON.stringify(identity)))
  storage.setItem(sharedIdentityCidKey, cid)
}

export async function createDidIdentity(): Promise<DidIdentity> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Web Crypto Ed25519 is not available')

  const keyPair = (await subtle.generateKey(ed25519Algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKeyRaw = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey))
  const privateKeyPkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', keyPair.privateKey))
  const publicKeyMultibase = publicKeyMultibaseFromEd25519(publicKeyRaw)
  return {
    did: didKeyFromPublicKeyMultibase(publicKeyMultibase),
    method: 'did:key',
    keyType: 'Ed25519',
    publicKeyMultibase,
    privateKeyPkcs8: bytesToBase64(privateKeyPkcs8),
    createdAt: new Date().toISOString(),
  }
}

export function publicDidIdentity(identity: DidIdentity): PublicDidIdentity {
  return {
    did: identity.did,
    method: identity.method,
    keyType: identity.keyType,
    publicKeyMultibase: identity.publicKeyMultibase,
    createdAt: identity.createdAt,
  }
}

export async function signStringWithDidIdentity(identity: DidIdentity, payload: string): Promise<string> {
  const privateKey = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    toArrayBuffer(base64ToBytes(identity.privateKeyPkcs8)),
    ed25519Algorithm,
    false,
    ['sign'],
  )
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign(ed25519Algorithm, privateKey, encoder.encode(payload)))
  return toBase64Url(bytesToBase64(signature))
}

export async function verifyStringWithDid(did: string, payload: string, signature: string): Promise<boolean> {
  const publicKeyRaw = ed25519PublicKeyFromDidKey(did)
  if (!publicKeyRaw) return false
  const publicKey = await globalThis.crypto.subtle.importKey('raw', toArrayBuffer(publicKeyRaw), ed25519Algorithm, false, ['verify'])
  return globalThis.crypto.subtle.verify(ed25519Algorithm, publicKey, toArrayBuffer(base64ToBytes(fromBase64Url(signature))), encoder.encode(payload))
}

export function publicKeyMultibaseFromEd25519(publicKeyRaw: Uint8Array): string {
  if (publicKeyRaw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes')
  return `z${encodeBase58(concatBytes(ed25519PublicKeyMulticodec, publicKeyRaw))}`
}

export function didKeyFromEd25519PublicKey(publicKeyRaw: Uint8Array): string {
  return didKeyFromPublicKeyMultibase(publicKeyMultibaseFromEd25519(publicKeyRaw))
}

export function didKeyFromPublicKeyMultibase(publicKeyMultibase: string): string {
  ed25519PublicKeyFromMultibase(publicKeyMultibase)
  return `did:key:${publicKeyMultibase}`
}

export function ed25519PublicKeyFromDidKey(did: string): Uint8Array | undefined {
  if (!did.startsWith('did:key:')) return undefined
  try {
    return ed25519PublicKeyFromMultibase(did.slice('did:key:'.length))
  } catch {
    return undefined
  }
}

export function isEd25519DidKey(did: string): boolean {
  return ed25519PublicKeyFromDidKey(did) !== undefined
}

function ed25519PublicKeyFromMultibase(publicKeyMultibase: string): Uint8Array {
  if (!publicKeyMultibase.startsWith('z')) throw new Error('DID key must use base58btc multibase')
  const bytes = decodeBase58(publicKeyMultibase.slice(1))
  if (bytes.length !== 34 || bytes[0] !== ed25519PublicKeyMulticodec[0] || bytes[1] !== ed25519PublicKeyMulticodec[1]) {
    throw new Error('DID key is not an Ed25519 public key')
  }
  return bytes.slice(2)
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  let leadingZeroCount = 0
  while (leadingZeroCount < bytes.length && bytes[leadingZeroCount] === 0) leadingZeroCount += 1
  if (leadingZeroCount === bytes.length) return base58Alphabet[0].repeat(leadingZeroCount)

  const digits = [0]
  for (let byteIndex = leadingZeroCount; byteIndex < bytes.length; byteIndex += 1) {
    const byte = bytes[byteIndex]
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry
      digits[index] = value % 58
      carry = Math.floor(value / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  return base58Alphabet[0].repeat(leadingZeroCount) + digits.reverse().map((digit) => base58Alphabet[digit]).join('')
}

function decodeBase58(value: string): Uint8Array {
  if (!value) return new Uint8Array()
  let leadingZeroCount = 0
  while (leadingZeroCount < value.length && value[leadingZeroCount] === base58Alphabet[0]) leadingZeroCount += 1
  if (leadingZeroCount === value.length) return new Uint8Array(leadingZeroCount)

  const bytes = [0]
  for (let charIndex = leadingZeroCount; charIndex < value.length; charIndex += 1) {
    const char = value[charIndex]
    const digit = base58Alphabet.indexOf(char)
    if (digit < 0) throw new Error('Invalid base58btc character')
    let carry = digit
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry
      bytes[index] = next & 0xff
      carry = next >> 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  return new Uint8Array([...new Uint8Array(leadingZeroCount), ...bytes.reverse()])
}

function toBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
}
