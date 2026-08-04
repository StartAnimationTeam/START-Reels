'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

/**
 * The 9:16 poster. Reads the file to base64 in the browser and sends it
 * through series-manage set_cover (service-role write into the public
 * series-covers bucket — no client storage credentials exist).
 *
 * The 1,000,000-byte client gate stays under the server's 1.4M base64 cap
 * (base64 inflates ~4/3), so an oversize file is refused before any network
 * call, with the same label the server would use.
 */
export function CoverUploader({ seriesId, coverUrl }: { seriesId: string; coverUrl: string | null }) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Local echo so the new cover shows immediately, before router.refresh.
  const [preview, setPreview] = useState<string | null>(null)

  const upload = async (file: File | undefined) => {
    if (!file || busy) return
    setError(null)

    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setError('bad_request')
      return
    }
    if (file.size > 1_000_000) {
      setError('upload_too_large')
      return
    }

    setBusy(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('read_failed'))
        reader.readAsDataURL(file)
      })
      const imageBase64 = dataUrl.split(',')[1] ?? ''

      const { series } = await api.series('set_cover', {
        seriesId,
        imageBase64,
        contentType: file.type,
      })
      setPreview((series?.cover_url as string | undefined) ?? dataUrl)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown_error')
    } finally {
      setBusy(false)
    }
  }

  const shown = preview ?? coverUrl

  return (
    <div className="w-full max-w-[220px] shrink-0">
      <p className="text-sm font-medium text-ink-secondary">Cover</p>
      <div className="mt-2 aspect-[2/3] overflow-hidden rounded-xl border border-line bg-surface-muted">
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-ink-faint">
            No cover yet — the first encoded episode’s thumbnail fills in until you upload one.
          </div>
        )}
      </div>

      <label className="mt-3 block">
        <span className="sr-only">Upload cover</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            void upload(e.target.files?.[0])
            e.target.value = '' // same file can be re-picked after a fix
          }}
          className="block w-full text-sm text-ink-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-surface-brand file:px-4 file:py-2 file:text-sm file:text-ink"
        />
      </label>
      <p className="mt-1 text-xs text-ink-muted">
        {busy ? 'Uploading…' : '9:16 portrait · JPEG/PNG/WebP · up to 1 MB'}
      </p>

      {error && <p className="mt-1 text-sm" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</p>}
    </div>
  )
}
