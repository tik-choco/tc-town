import { useEffect, useRef, useState } from 'preact/hooks'
import type { VRM } from '@pixiv/three-vrm'
import type { Character, ImageAvatar, VrmAvatar } from '../types'
import { getBlob } from '../lib/idbBlobStore'
import { loadVrmForAvatar, disposeVrm } from '../vrm/loader'
import type { AvatarScene } from '../vrm/stage'
import { createAvatarScene, mountBustInPool } from '../vrm/stage'
import { getCharacterEmotion } from '../lib/emotionStore'
import '../styles/avatar.css'

// The single integration point other views use to render a character's avatar
// regardless of kind: `<CharacterAvatar character={c} speaking={...} />`.
// - null avatar -> initial-letter placeholder (unchanged look)
// - image avatar -> <img> of the stored blob
// - VRM avatar -> a head-and-shoulders bust rendered by the shared-renderer
//   pool (one WebGL context for any number of mounted bust avatars), with the
//   mouth animating while `speaking` is true.
// A VRM bust reads best as a portrait crop (head down to the chest) rather
// than a square, so it defaults to a taller-than-wide frame. `size` is always
// the *width*; height is derived from `aspect` (width / height) so existing
// call sites that only pass `size` keep a predictable, modest footprint
// increase instead of an unbounded one.
const DEFAULT_VRM_ASPECT = 3 / 4
// A "full" (head-to-toe) framing needs a much taller-than-wide frame than the
// bust crop so the standing body fits without being squeezed sideways.
const DEFAULT_VRM_FULL_ASPECT = 1 / 2
// "upper" (head-to-hips) sits between the two.
const DEFAULT_VRM_UPPER_ASPECT = 3 / 5

export function CharacterAvatar(props: {
  character: Character
  speaking?: boolean
  size?: number
  // width / height. Defaults to 1 (square) for image/placeholder and to a
  // portrait ratio for VRM busts so head-to-chest fits without clipping.
  aspect?: number
  // 'circle' keeps the classic round crop (image/placeholder default);
  // 'rounded' uses a squared-off frame so a VRM bust's head isn't clipped;
  // 'frameless' drops the background/clip entirely so a VRM bust floats on a
  // transparent canvas instead of sitting inside a visible frame (VRM default).
  shape?: 'circle' | 'rounded' | 'frameless'
  // 'bust' (default) frames head-to-chest; 'upper' frames head-to-hips;
  // 'full' frames the whole standing body (feet to crown). Only affects VRM
  // avatars.
  framing?: 'bust' | 'upper' | 'full'
  // When true the avatar fills its parent element (width/height 100%) instead
  // of sizing itself from `size` — the parent owns the box, e.g. a
  // CSS-responsive stage. `size` then only scales the placeholder initial.
  fill?: boolean
  // When true, dragging the avatar with mouse or touch orbits the camera
  // around it. Only meaningful for VRM avatars; image/placeholder ignore it.
  interactive?: boolean
}) {
  const size = props.size ?? 96
  const avatar = props.character.avatar
  const initial = props.character.sheet.name.trim().slice(0, 1) || '?'
  const framing = props.framing ?? 'bust'

  if (avatar?.kind === 'image') {
    return (
      <ImageAvatarView
        avatar={avatar}
        size={size}
        aspect={props.aspect ?? 1}
        speaking={props.speaking}
        initial={initial}
        shape={props.shape ?? 'circle'}
        fill={props.fill}
      />
    )
  }
  if (avatar?.kind === 'vrm') {
    return (
      <VrmBustView
        avatar={avatar}
        character={props.character}
        size={size}
        aspect={
          props.aspect ??
          (framing === 'full' ? DEFAULT_VRM_FULL_ASPECT : framing === 'upper' ? DEFAULT_VRM_UPPER_ASPECT : DEFAULT_VRM_ASPECT)
        }
        framing={framing}
        speaking={props.speaking}
        initial={initial}
        shape={props.shape ?? 'frameless'}
        fill={props.fill}
        interactive={props.interactive}
      />
    )
  }
  return (
    <Placeholder
      size={size}
      aspect={props.aspect ?? 1}
      speaking={props.speaking}
      initial={initial}
      shape={props.shape ?? 'circle'}
      fill={props.fill}
    />
  )
}

type AvatarShape = 'circle' | 'rounded' | 'frameless'

function shapeClass(shape: AvatarShape): string {
  if (shape === 'rounded') return ' tc-avatar--rect'
  if (shape === 'frameless') return ' tc-avatar--frameless'
  return ''
}

/** `size` is the width in px; `height` is derived from `aspect` (width / height). */
function dimensions(size: number, aspect: number): { width: number; height: number } {
  return { width: size, height: Math.round(size / aspect) }
}

/** Inline box style: parent-owned (100%) in fill mode, else px from size/aspect. */
function boxStyle(size: number, aspect: number, fill?: boolean): { width: number | string; height: number | string } {
  return fill ? { width: '100%', height: '100%' } : dimensions(size, aspect)
}

function Placeholder(props: { size: number; aspect: number; speaking?: boolean; initial: string; shape: AvatarShape; fill?: boolean }) {
  return (
    <div
      class={`tc-avatar${shapeClass(props.shape)}${props.speaking ? ' tc-avatar--speaking' : ''}`}
      style={boxStyle(props.size, props.aspect, props.fill)}
    >
      <span class="tc-avatar__initial" style={{ fontSize: props.size * 0.4 }}>
        {props.initial}
      </span>
    </div>
  )
}

function ImageAvatarView(props: { avatar: ImageAvatar; size: number; aspect: number; speaking?: boolean; initial: string; shape: AvatarShape; fill?: boolean }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    getBlob(props.avatar.blobKey)
      .then((blob) => {
        if (cancelled || !blob) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setUrl(null)
    }
  }, [props.avatar.blobKey])

  return (
    <div
      class={`tc-avatar${shapeClass(props.shape)}${props.speaking ? ' tc-avatar--speaking' : ''}`}
      style={boxStyle(props.size, props.aspect, props.fill)}
    >
      {url ? (
        <img class="tc-avatar__img" src={url} alt={props.initial} />
      ) : (
        <span class="tc-avatar__initial" style={{ fontSize: props.size * 0.4 }}>
          {props.initial}
        </span>
      )}
    </div>
  )
}

function VrmBustView(props: {
  avatar: VrmAvatar
  character: Character
  size: number
  aspect: number
  framing: 'bust' | 'upper' | 'full'
  speaking?: boolean
  initial: string
  shape: AvatarShape
  fill?: boolean
  interactive?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)

  // Latest `speaking` value read by the render loop without re-running the
  // (expensive) load effect on every toggle.
  const speakingRef = useRef(props.speaking ?? false)
  speakingRef.current = props.speaking ?? false

  // The scene backing the mounted bust, so pointer handlers can drive
  // `orbit` without re-running the load effect or triggering re-renders.
  const sceneRef = useRef<AvatarScene | null>(null)

  // Drag bookkeeping lives in refs (not state) — onPointerMove fires far too
  // often to route through Preact's render cycle.
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number; mode: 'rotate' | 'pan' } | null>(null)

  const characterId = props.character.id

  useEffect(() => {
    let cancelled = false
    let vrm: VRM | null = null
    let unmount: (() => void) | null = null
    setReady(false)

    loadVrmForAvatar(props.avatar)
      .then((loaded) => {
        const canvas = canvasRef.current
        if (cancelled || !canvas) {
          disposeVrm(loaded)
          return
        }
        vrm = loaded
        const scene = createAvatarScene(loaded, props.aspect, props.framing)
        sceneRef.current = scene
        unmount = mountBustInPool(
          scene,
          canvas,
          () => speakingRef.current,
          () => getCharacterEmotion(characterId),
        )
        setReady(true)
      })
      .catch(() => {
        if (!cancelled) setReady(false)
      })

    return () => {
      cancelled = true
      if (unmount) unmount()
      if (vrm) disposeVrm(vrm)
      sceneRef.current = null
    }
  }, [props.avatar.checksum, props.avatar.blobKey, props.framing, characterId])

  const interactive = props.interactive && ready

  const endDrag = (e: PointerEvent) => {
    const canvas = e.currentTarget as HTMLCanvasElement
    if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
      dragRef.current = null
      canvas.style.cursor = 'grab'
    }
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
  }

  const handlePointerDown = (e: PointerEvent) => {
    if (!interactive) return
    const canvas = e.currentTarget as HTMLCanvasElement
    // Right button (or Shift+drag, for mice without one / trackpads) pans;
    // plain left drag orbits.
    const mode = e.button === 2 || e.shiftKey ? 'pan' : 'rotate'
    dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, mode }
    canvas.setPointerCapture(e.pointerId)
    canvas.style.cursor = mode === 'pan' ? 'move' : 'grabbing'
  }

  const handlePointerMove = (e: PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.lastX
    const dy = e.clientY - drag.lastY
    drag.lastX = e.clientX
    drag.lastY = e.clientY
    if (drag.mode === 'pan') {
      // Normalize by the viewport height so panBy can move the pivot 1:1
      // with the cursor at any canvas size.
      const height = (e.currentTarget as HTMLCanvasElement).clientHeight || 1
      sceneRef.current?.orbit.panBy(dx / height, dy / height)
    } else {
      sceneRef.current?.orbit.rotateBy(-dx * 0.008, dy * 0.006)
    }
  }

  const handleDblClick = () => {
    if (!interactive) return
    sceneRef.current?.orbit.reset()
  }

  const handleWheel = (e: WheelEvent) => {
    // Wheel zoom (PC). preventDefault keeps the page from scrolling while
    // the cursor is over the avatar; the exp() mapping makes each notch a
    // constant zoom ratio regardless of direction or device delta scale.
    e.preventDefault()
    sceneRef.current?.orbit.zoomBy(Math.exp(e.deltaY * 0.0012))
  }

  // Keep the classic surface-backed frame while the model is still loading
  // (there's nothing to see through yet), and only switch to the requested
  // (frameless, by default) look once the bust is actually rendering. The
  // wrapper's box size stays constant across that swap so there's no layout
  // shift when it happens.
  const displayShape: AvatarShape = ready ? props.shape : 'rounded'
  return (
    <div
      class={`tc-avatar${shapeClass(displayShape)}${props.speaking ? ' tc-avatar--speaking' : ''}`}
      style={boxStyle(props.size, props.aspect, props.fill)}
    >
      <canvas
        ref={canvasRef}
        class="tc-avatar__canvas"
        style={interactive ? { touchAction: 'none', cursor: 'grab' } : undefined}
        onPointerDown={interactive ? handlePointerDown : undefined}
        onPointerMove={interactive ? handlePointerMove : undefined}
        onPointerUp={interactive ? endDrag : undefined}
        onPointerCancel={interactive ? endDrag : undefined}
        onDblClick={interactive ? handleDblClick : undefined}
        onWheel={interactive ? handleWheel : undefined}
        // Right-drag pans, so the browser context menu must not pop on release.
        onContextMenu={interactive ? (e: MouseEvent) => e.preventDefault() : undefined}
      />
      {!ready && (
        <span class="tc-avatar__initial" style={{ fontSize: props.size * 0.4 }}>
          {props.initial}
        </span>
      )}
    </div>
  )
}
