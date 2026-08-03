'use client'

import { useUser } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useSupabase } from '@/lib/supabase-browser'

/**
 * Profile + notification settings. All direct RLS writes — the column grant
 * on profiles allows exactly display_name / avatar_path / bio, and the
 * notification channels are the caller's own row. Nothing here moves value.
 *
 * The avatar goes to the public `avatars` bucket under a folder named by the
 * caller's Clerk id — storage RLS pins the path, so the client physically
 * cannot write anywhere else. Timestamped filename busts CDN caches on
 * change.
 */

const STORAGE_PUBLIC = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/avatars/`

const NOTIFY_ROWS: Array<{ key: string; label: string }> = [
  { key: 'upload_reviewed', label: 'My uploads are approved or rejected' },
  { key: 'credit_granted', label: 'Credits are added to my account' },
  { key: 'warning_issued', label: 'A moderator issues a warning' },
  { key: 'weekly_digest', label: 'Weekly digest of new videos' },
]

export function SettingsForm({
  initialDisplayName,
  initialBio,
  initialAvatarPath,
  initialChannels,
}: {
  initialDisplayName: string
  initialBio: string
  initialAvatarPath: string | null
  initialChannels: Record<string, Record<string, boolean>> | null
}) {
  const { user } = useUser()
  const supabase = useSupabase()
  const router = useRouter()

  const [displayName, setDisplayName] = useState(initialDisplayName)
  const [bio, setBio] = useState(initialBio)
  const [avatarPath, setAvatarPath] = useState(initialAvatarPath)
  const [email, setEmail] = useState<Record<string, boolean>>(initialChannels?.email ?? {})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  if (!user || !supabase) return null

  const save = async () => {
    setBusy(true)
    setMessage(null)

    const [profileRes, prefsRes] = await Promise.all([
      supabase
        .from('profiles')
        .update({
          display_name: displayName.trim() || null,
          bio: bio.trim() || null,
          avatar_path: avatarPath,
        })
        .eq('user_id', user.id),
      supabase
        .from('notification_preferences')
        .update({ channels: { ...(initialChannels ?? {}), email } })
        .eq('user_id', user.id),
    ])

    if (profileRes.error || prefsRes.error) {
      setMessage({ ok: false, text: 'Couldn’t save. Try again in a moment.' })
    } else {
      setMessage({ ok: true, text: 'Saved.' })
      router.refresh()
    }
    setBusy(false)
  }

  const uploadAvatar = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      setMessage({ ok: false, text: 'Avatars are limited to 2 MB.' })
      return
    }
    setBusy(true)
    setMessage(null)

    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
    const path = `${user.id}/avatar-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('avatars').upload(path, file, {
      contentType: file.type || 'image/jpeg',
      upsert: true,
    })

    if (error) {
      setMessage({ ok: false, text: 'Avatar upload failed. Try a smaller image.' })
    } else {
      setAvatarPath(path)
      // Persist immediately — an uploaded-but-unsaved avatar is a confusing
      // half-state that a page refresh would silently discard.
      await supabase.from('profiles').update({ avatar_path: path }).eq('user_id', user.id)
      setMessage({ ok: true, text: 'Avatar updated.' })
      router.refresh()
    }
    setBusy(false)
  }

  return (
    <div className="space-y-8">
      {/* ── avatar ─────────────────────────────────────────────────────── */}
      <section className="flex items-center gap-5">
        <div className="h-20 w-20 overflow-hidden rounded-full border border-line-strong bg-surface-muted">
          {avatarPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`${STORAGE_PUBLIC}${avatarPath}`} alt="Your avatar" className="h-full w-full object-cover" />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center text-xl font-semibold text-white"
              style={{ background: 'var(--brand-gradient)' }}
            >
              {(displayName || user.primaryEmailAddress?.emailAddress || '?').slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>
        <label className="cursor-pointer rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary transition-colors hover:border-brand hover:text-ink">
          Change avatar
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void uploadAvatar(file)
              e.target.value = ''
            }}
          />
        </label>
      </section>

      {/* ── profile ────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <label className="text-sm font-medium text-ink-secondary" htmlFor="set-name">Display name</label>
          <input
            id="set-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={80}
            className="mt-1 w-full rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-ink-secondary" htmlFor="set-bio">Bio</label>
          <textarea
            id="set-bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            maxLength={500}
            className="mt-1 w-full rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
        </div>
      </section>

      {/* ── notifications ──────────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-medium text-ink-secondary">Email me when…</h2>
        <div className="mt-3 space-y-2">
          {NOTIFY_ROWS.map((row) => (
            <label key={row.key} className="flex cursor-pointer items-center gap-3 text-sm text-ink">
              <input
                type="checkbox"
                checked={email[row.key] ?? false}
                onChange={(e) => setEmail({ ...email, [row.key]: e.target.checked })}
                className="h-4 w-4 accent-[var(--brand)]"
              />
              {row.label}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-faint">
          Email delivery itself arrives with the notifications service (Phase 8) — preferences saved
          now apply from day one.
        </p>
      </section>

      <div className="flex items-center gap-4">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
          style={{ background: 'var(--brand-gradient)' }}
        >
          Save changes
        </button>
        {message && (
          <span className="text-sm" style={{ color: message.ok ? 'var(--success)' : 'var(--danger)' }}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  )
}
