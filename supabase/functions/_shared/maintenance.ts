import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.111.0'

/**
 * Maintenance mode gate for the value-moving paths (unlock, playback).
 *
 * Deliberately NOT enforced in the proxy or the catalog: browsing during
 * maintenance is harmless, and blocking reads would hide the banner
 * explaining what's going on. Staff pass through so they can verify the fix
 * before switching it off.
 *
 * Returns true when the caller should be blocked.
 */
export async function maintenanceBlocks(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data: setting } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'maintenance_mode')
    .maybeSingle()

  if (String(setting?.value ?? 'false') !== 'true') return false

  // Only pay the roles query when maintenance is actually on.
  const { data: roles } = await db.from('user_roles').select('role').eq('user_id', userId)
  return !(roles ?? []).some(
    (r: { role: string }) => r.role === 'moderator' || r.role === 'administrator',
  )
}
