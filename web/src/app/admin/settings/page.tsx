import type { Metadata } from 'next'

import { SettingsPanel } from './SettingsPanel'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Settings · Admin' }

/**
 * Platform settings — exactly the keys admin-platform's allowlist accepts.
 * Keys outside it (timezone, upload caps) are deliberately migration-only:
 * changing the platform's day boundary with a click is how daily-reward
 * accounting quietly breaks.
 */
export default async function AdminSettingsPage() {
  const supabase = await createServerSupabase()
  const { data } = await supabase.from('platform_settings').select('key, value, description')

  const settings = Object.fromEntries((data ?? []).map((s) => [s.key, s.value]))

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold tracking-tight">Platform settings</h2>
      <div className="mt-4">
        <SettingsPanel
          initial={{
            maintenance_mode: settings.maintenance_mode === true || settings.maintenance_mode === 'true',
            signup_grant_credits: Number(settings.signup_grant_credits ?? 10),
            daily_reward_enabled: settings.daily_reward_enabled === true || settings.daily_reward_enabled === 'true',
            daily_reward_amount: Number(settings.daily_reward_amount ?? 1),
            entitlement_window_hours: Number(settings.entitlement_window_hours ?? 48),
            settle_after_seconds: Number(settings.settle_after_seconds ?? 30),
            max_concurrent_streams: Number(settings.max_concurrent_streams ?? 2),
            ad_rewards_enabled: settings.ad_rewards_enabled === true || settings.ad_rewards_enabled === 'true',
            ad_test_mode: settings.ad_test_mode === true || settings.ad_test_mode === 'true',
            ad_reward_amount: Number(settings.ad_reward_amount ?? 5),
            ad_reward_daily_cap: Number(settings.ad_reward_daily_cap ?? 10),
            ad_reward_min_interval_seconds: Number(settings.ad_reward_min_interval_seconds ?? 30),
          }}
        />
      </div>
      <p className="mt-6 text-xs text-ink-faint">
        Timezone and upload caps are deliberately not editable here — those are
        migration-level changes with accounting consequences.
      </p>
    </div>
  )
}
