import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import { AuthError, requireUser } from './auth.ts'

/**
 * Admin-function plumbing: authenticate, load roles from OUR table, audit.
 *
 * Roles come from user_roles, never from Clerk metadata — a Clerk token says
 * who you are; our table says what you may do. And every mutation writes
 * audit_logs BEFORE returning success: an admin action that isn't in the
 * audit trail didn't happen, as far as this platform is concerned.
 */

export interface AdminContext {
  userId: string
  roles: string[]
  isAdmin: boolean
  isStaff: boolean
}

export async function requireStaffContext(
  req: Request,
  db: SupabaseClient,
): Promise<AdminContext> {
  const userId = await requireUser(req) // throws AuthError('unauthorized')

  const { data } = await db.from('user_roles').select('role').eq('user_id', userId)
  const roles = (data ?? []).map((r: { role: string }) => r.role)
  const isAdmin = roles.includes('administrator')
  const isStaff = isAdmin || roles.includes('moderator')

  if (!isStaff) throw new AuthError('forbidden')
  return { userId, roles, isAdmin, isStaff }
}

export async function audit(
  db: SupabaseClient,
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  const { error } = await db.from('audit_logs').insert({
    actor_id: actor,
    action,
    target_type: targetType,
    target_id: targetId,
    before: before ?? null,
    after: after ?? null,
  })
  // An unauditable mutation must fail loudly, not proceed quietly.
  if (error) throw new Error(`audit_write_failed: ${error.message}`)
}
