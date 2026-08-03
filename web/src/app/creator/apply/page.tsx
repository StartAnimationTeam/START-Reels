import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { ApplyForm } from './ApplyForm'
import { requireUser, rolesOf } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Apply · Creator studio' }

export default async function ApplyPage() {
  const userId = await requireUser()

  // Already a creator, or an application already open? The form would only
  // produce a constraint error — send them to the studio instead.
  const roles = await rolesOf(userId)
  if (roles.length > 0) redirect('/creator')

  const supabase = await createServerSupabase()
  const { data: open } = await supabase
    .from('creator_applications')
    .select('id')
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle()
  if (open) redirect('/creator')

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Apply to become a creator</h1>
      <p className="mt-2 text-sm text-ink-secondary">
        Tell the team who you are and what you’d publish. Applications are
        reviewed by an administrator.
      </p>
      <div className="mt-6">
        <ApplyForm userId={userId} />
      </div>
    </div>
  )
}
