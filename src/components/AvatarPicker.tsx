import { useEffect, useRef, useState } from 'preact/hooks'
import { X } from 'lucide-preact'
import type { Avatar } from '../types'
import { putBlob, deleteBlob } from '../lib/idbBlobStore'
import { listVrmModels, importVrmFile, deleteVrmModel, type VrmModelInfo } from '../vrm/library'
import '../styles/avatar.css'

// Avatar chooser mounted by the character editor. Lets the user either upload
// an image (stored in idbBlobStore) or pick / import a VRM model from the
// shared library (schema-compatible with tc-vrm-viewer). UI text is Japanese.
export function AvatarPicker(props: { avatar: Avatar | null; onChange: (avatar: Avatar | null) => void }) {
  const [tab, setTab] = useState<'image' | 'vrm'>(props.avatar?.kind === 'vrm' ? 'vrm' : 'image')
  const [models, setModels] = useState<VrmModelInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const vrmInputRef = useRef<HTMLInputElement>(null)

  const refreshModels = () => {
    listVrmModels()
      .then(setModels)
      .catch(() => setError('モデル一覧の読み込みに失敗しました'))
  }

  useEffect(() => {
    refreshModels()
  }, [])

  const currentImageKey = props.avatar?.kind === 'image' ? props.avatar.blobKey : null

  const handleImageFile = async (file: File) => {
    setError(null)
    setBusy(true)
    try {
      const blobKey = `avatar-img-${crypto.randomUUID()}`
      await putBlob(blobKey, file)
      // Drop the previously stored image so it doesn't orphan in IndexedDB.
      if (currentImageKey) await deleteBlob(currentImageKey).catch(() => {})
      props.onChange({ kind: 'image', blobKey, mime: file.type || 'image/png' })
    } catch {
      setError('画像の保存に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const handleVrmFile = async (file: File) => {
    setError(null)
    setBusy(true)
    try {
      const info = await importVrmFile(file)
      refreshModels()
      selectModel(info)
    } catch {
      setError('VRMの読み込みに失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const selectModel = (model: VrmModelInfo) => {
    props.onChange({ kind: 'vrm', blobKey: model.id, checksum: model.checksum, fileName: model.name })
  }

  const removeModel = async (model: VrmModelInfo) => {
    await deleteVrmModel(model.id).catch(() => {})
    if (props.avatar?.kind === 'vrm' && props.avatar.checksum === model.checksum) props.onChange(null)
    refreshModels()
  }

  const clear = () => {
    if (currentImageKey) deleteBlob(currentImageKey).catch(() => {})
    props.onChange(null)
  }

  const avatarLabel =
    props.avatar?.kind === 'image'
      ? '画像アバター'
      : props.avatar?.kind === 'vrm'
        ? `VRM: ${props.avatar.fileName}`
        : 'アバター未設定'

  return (
    <div class="tc-avatar-picker">
      <div class="tc-avatar-picker__preview">
        <div class="tc-avatar-picker__meta">
          <span class="tc-avatar-picker__meta-name">{avatarLabel}</span>
          <span class="tc-avatar-picker__meta-kind">
            {props.avatar ? '設定済み' : 'デフォルトの頭文字が表示されます'}
          </span>
        </div>
        {props.avatar && (
          <button type="button" class="tc-avatar-picker__btn tc-avatar-picker__btn--danger" onClick={clear}>
            クリア
          </button>
        )}
      </div>

      <div class="tc-avatar-picker__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'image'}
          class={`tc-avatar-picker__tab${tab === 'image' ? ' tc-avatar-picker__tab--active' : ''}`}
          onClick={() => setTab('image')}
        >
          画像
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'vrm'}
          class={`tc-avatar-picker__tab${tab === 'vrm' ? ' tc-avatar-picker__tab--active' : ''}`}
          onClick={() => setTab('vrm')}
        >
          VRMモデル
        </button>
      </div>

      {error && <p class="tc-avatar-picker__error">{error}</p>}

      {tab === 'image' ? (
        <div class="tc-avatar-picker__panel">
          <div class="tc-avatar-picker__row">
            <button
              type="button"
              class="tc-avatar-picker__btn tc-avatar-picker__btn--primary"
              disabled={busy}
              onClick={() => imageInputRef.current?.click()}
            >
              画像を選択
            </button>
          </div>
          <input
            ref={imageInputRef}
            class="tc-avatar-picker__hidden-input"
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) void handleImageFile(file)
            }}
          />
        </div>
      ) : (
        <div class="tc-avatar-picker__panel">
          <div class="tc-avatar-picker__row">
            <button
              type="button"
              class="tc-avatar-picker__btn tc-avatar-picker__btn--primary"
              disabled={busy}
              onClick={() => vrmInputRef.current?.click()}
            >
              VRMをインポート
            </button>
          </div>
          <input
            ref={vrmInputRef}
            class="tc-avatar-picker__hidden-input"
            type="file"
            accept=".vrm,model/gltf-binary"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) void handleVrmFile(file)
            }}
          />
          {models.length === 0 ? (
            <p class="tc-avatar-picker__empty">保存済みのVRMモデルはありません。上のボタンから追加できます。</p>
          ) : (
            <ul class="tc-avatar-picker__list">
              {models.map((model) => {
                const active = props.avatar?.kind === 'vrm' && props.avatar.checksum === model.checksum
                return (
                  <li key={model.id} class="tc-avatar-picker__item">
                    <button
                      type="button"
                      class={`tc-avatar-picker__item-select${active ? ' tc-avatar-picker__item-select--active' : ''}`}
                      aria-pressed={active}
                      onClick={() => selectModel(model)}
                    >
                      <span class="tc-avatar-picker__item-name">{model.name}</span>
                      <span class="tc-avatar-picker__item-size">{formatBytes(model.size)}</span>
                    </button>
                    <button
                      type="button"
                      class="tc-avatar-picker__item-remove"
                      aria-label={`${model.name} を削除`}
                      onClick={() => void removeModel(model)}
                    >
                      <X size={14} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let size = bytes / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`
}
