// VRM loading from raw bytes, mirroring tc-vrm-viewer's vrmLoader.ts. A single
// shared GLTFLoader (with the VRM plugin) is reused for every parse. Bytes are
// cached per library key so re-mounting the same avatar doesn't re-read
// IndexedDB, but each mount parses its own VRM instance — a three.js object can
// only live in one scene at a time, so VRM instances are never shared.

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import type { VrmAvatar } from '../types'
import { getVrmBytesForAvatar } from './library'

const loader = new GLTFLoader()
loader.register((parser) => new VRMLoaderPlugin(parser))

const byteCache = new Map<string, Uint8Array>()

/** Parse a VRM from raw `.vrm` bytes (GLTFLoader + VRMLoaderPlugin). */
export async function loadVrmFromBytes(bytes: Uint8Array): Promise<VRM> {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const gltf = await loader.parseAsync(arrayBuffer, '')
  const vrm = gltf.userData.vrm as VRM
  VRMUtils.removeUnnecessaryVertices(gltf.scene)
  VRMUtils.combineSkeletons(gltf.scene)
  VRMUtils.combineMorphs(vrm)
  // VRM0.x models face +Z (away from our camera); this flips them 180deg to
  // face us. No-op for VRM1.0 models.
  VRMUtils.rotateVRM0(vrm)
  vrm.scene.traverse((object) => {
    object.frustumCulled = false
  })
  return vrm
}

/**
 * Load and parse the VRM referenced by an avatar. Bytes are cached by the
 * avatar's checksum; the returned VRM is a fresh instance owned by the caller
 * (dispose via disposeVrm when the scene unmounts).
 */
export async function loadVrmForAvatar(avatar: VrmAvatar): Promise<VRM> {
  let bytes = byteCache.get(avatar.checksum)
  if (!bytes) {
    bytes = await getVrmBytesForAvatar(avatar.blobKey, avatar.checksum)
    if (!bytes) throw new Error(`VRM model not found for ${avatar.fileName}`)
    byteCache.set(avatar.checksum, bytes)
  }
  return loadVrmFromBytes(bytes)
}

/** Free all GPU/geometry resources held by a VRM instance. */
export function disposeVrm(vrm: VRM): void {
  VRMUtils.deepDispose(vrm.scene)
}
