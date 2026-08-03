import type { Metadata } from 'next'

import { SettingsForm } from './SettingsForm'
import { requireUser } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  await requireUser()
  const supabase = await createServerSupabase()

  const [{ data: profile }, { data: prefs }] = await Promise.all([
    supabase.from('profiles').select('display_name, bio, avatar_path').maybeSingle(),
    supabase.from('notification_preferences').select('channels').maybeSingle(),
  ])

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="mt-6">
        <SettingsForm
          initialDisplayName={profile?.display_name ?? ''}
          initialBio={profile?.bio ?? ''}
          initialAvatarPath={profile?.avatar_path ?? null}
          initialChannels={(prefs?.channels as Record<string, Record<string, boolean>> | null) ?? null}
        />
      </div>
    </div>
  )
}
