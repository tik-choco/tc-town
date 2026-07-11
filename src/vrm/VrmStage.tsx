import { useEffect, useRef } from 'preact/hooks'
import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { Character } from '../types'
import { loadVrmForAvatar, disposeVrm } from './loader'
import { addAvatarLights } from './stage'
import { createVrmAnimator, type VrmAnimator } from './animation'
import { getCharacterEmotion } from '../lib/emotionStore'
import '../styles/avatar.css'

export interface VrmStageActor {
  character: Character
  speaking?: boolean
}

// Full-body "town" stage: several characters' VRM models composited into one
// three.js scene on a single live canvas (one dedicated WebGL context — separate
// from the CharacterAvatar bust pool). Characters without a VRM avatar are
// skipped. Actors can be added/removed/updated live; speaking drives mouth
// movement per character.
export function VrmStage(props: { actors: VrmStageActor[]; class?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<StageController | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const controller = new StageController(container)
    controllerRef.current = controller
    return () => {
      controllerRef.current = null
      controller.dispose()
    }
  }, [])

  useEffect(() => {
    controllerRef.current?.setActors(props.actors)
  }, [props.actors])

  return <div ref={containerRef} class={`tc-vrm-stage ${props.class ?? ''}`} />
}

interface Slot {
  checksum: string | null
  vrm: VRM | null
  animator: VrmAnimator | null
  speaking: boolean
  /** Generation token to ignore stale async loads. */
  generation: number
}

class StageController {
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private canvas: HTMLCanvasElement
  private clock = new THREE.Clock()
  private resizeObserver: ResizeObserver
  private slots = new Map<string, Slot>()
  private frameId = 0
  private disposed = false
  private container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container
    this.scene.background = null
    addAvatarLights(this.scene)

    const width = Math.max(1, container.clientWidth)
    const height = Math.max(1, container.clientHeight)
    this.camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100)
    this.camera.position.set(0, 1.1, 3)
    this.camera.lookAt(0, 0.9, 0)

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(width, height)
    this.canvas = this.renderer.domElement
    this.canvas.className = 'tc-vrm-stage__canvas'
    container.appendChild(this.canvas)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)

    this.frameId = requestAnimationFrame(this.tick)
  }

  setActors(actors: VrmStageActor[]): void {
    if (this.disposed) return
    const vrmActors = actors.filter((actor) => actor.character.avatar?.kind === 'vrm')
    const seen = new Set<string>()

    for (const actor of vrmActors) {
      const avatar = actor.character.avatar
      if (avatar?.kind !== 'vrm') continue
      const key = actor.character.id
      seen.add(key)
      const speaking = actor.speaking ?? false

      let slot = this.slots.get(key)
      if (!slot) {
        slot = { checksum: null, vrm: null, animator: null, speaking, generation: 0 }
        this.slots.set(key, slot)
      }
      slot.speaking = speaking

      if (slot.checksum !== avatar.checksum) {
        // New or changed model for this slot — (re)load.
        slot.checksum = avatar.checksum
        slot.generation += 1
        const generation = slot.generation
        if (slot.vrm) {
          this.scene.remove(slot.vrm.scene)
          disposeVrm(slot.vrm)
          slot.vrm = null
          slot.animator = null
        }
        loadVrmForAvatar(avatar)
          .then((vrm) => {
            const current = this.slots.get(key)
            if (this.disposed || !current || current.generation !== generation) {
              disposeVrm(vrm)
              return
            }
            if (vrm.lookAt) vrm.lookAt.target = this.camera
            current.vrm = vrm
            current.animator = createVrmAnimator(vrm)
            this.scene.add(vrm.scene)
            this.layout()
          })
          .catch(() => {})
      }
    }

    // Remove slots whose character is no longer present.
    for (const [key, slot] of [...this.slots]) {
      if (seen.has(key)) continue
      if (slot.vrm) {
        this.scene.remove(slot.vrm.scene)
        disposeVrm(slot.vrm)
      }
      this.slots.delete(key)
    }

    this.layout()
  }

  /** Space loaded characters evenly across X, feet on the ground plane. */
  private layout(): void {
    const loaded = [...this.slots.values()].filter((slot) => slot.vrm)
    const spacing = 0.9
    const offset = ((loaded.length - 1) * spacing) / 2
    loaded.forEach((slot, index) => {
      if (slot.vrm) slot.vrm.scene.position.set(index * spacing - offset, 0, 0)
    })

    // Pull the camera back as the cast grows so everyone stays framed.
    const distance = 2.6 + loaded.length * 0.5
    this.camera.position.set(0, 1.1, distance)
    this.camera.lookAt(0, 0.9, 0)
  }

  private resize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0) return
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  private tick = (): void => {
    if (this.disposed) return
    const delta = this.clock.getDelta()
    for (const [characterId, slot] of this.slots) {
      if (!slot.vrm) continue
      slot.animator?.update(delta, slot.speaking, getCharacterEmotion(characterId))
      slot.vrm.update(delta)
    }
    this.renderer.render(this.scene, this.camera)
    this.frameId = requestAnimationFrame(this.tick)
  }

  dispose(): void {
    this.disposed = true
    if (this.frameId) cancelAnimationFrame(this.frameId)
    this.resizeObserver.disconnect()
    for (const slot of this.slots.values()) {
      if (slot.vrm) {
        this.scene.remove(slot.vrm.scene)
        disposeVrm(slot.vrm)
      }
    }
    this.slots.clear()
    this.renderer.dispose()
    this.canvas.remove()
  }
}
