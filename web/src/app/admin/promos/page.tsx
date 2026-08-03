import type { Metadata } from 'next'

import { PromoManager } from './PromoManager'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Promos · Admin' }

/**
 * Promo campaigns — visible only through the admin RLS policy (users can't
 * even SELECT this table; a listable code list is a leaked code list).
 * Redemption counts come from one grouped query, not one per row.
 */
export default async function AdminPromosPage() {
  const supabase = await createServerSupabase()

  const [{ data: campaigns }, { data: redemptions }] = await Promise.all([
    supabase
      .from('promo_campaigns')
      .select('id, code, name, amount, per_user_limit, max_redemptions, is_active, ends_at, created_at')
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.from('promo_redemptions').select('campaign_id'),
  ])

  const usedBy = new Map<string, number>()
  for (const row of redemptions ?? []) {
    usedBy.set(row.campaign_id, (usedBy.get(row.campaign_id) ?? 0) + 1)
  }

  const rows = (campaigns ?? []).map((campaign) => ({
    ...campaign,
    used: usedBy.get(campaign.id) ?? 0,
  }))

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Promo campaigns</h2>
      <div className="mt-4">
        <PromoManager campaigns={rows} />
      </div>
    </div>
  )
}
