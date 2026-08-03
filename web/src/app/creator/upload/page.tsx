import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { UploadForm } from '@/components/UploadForm'
import { requireUser, rolesOf } from '@/lib/auth'

export const metadata: Metadata = { title: 'Upload · Creator studio' }

export default async function CreatorUploadPage() {
  const userId = await requireUser()
  const roles = await rolesOf(userId)
  // The video-upload function re-checks this server-side; the redirect is UX.
  if (roles.length === 0) redirect('/creator')

  const isStaff = roles.includes('moderator') || roles.includes('administrator')

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Upload a video</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {isStaff
          ? 'Staff uploads publish automatically when encoding finishes.'
          : 'Your upload goes to the moderation queue when encoding finishes — it publishes once approved.'}
      </p>
      <div className="mt-6">
        <UploadForm redirectTo="/creator" reviewNotice={!isStaff} />
      </div>
    </div>
  )
}
