import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'

import type { AppRole } from './database.types'
import { createServerSupabase } from './supabase-server'

/**
 * Resource-based authorization.
 *
 * These live next to the data they protect rather than in a proxy path matcher.
 * Clerk deprecated `createRouteMatcher` because matcher patterns can diverge
 * from how Next.js actually routes a request, leaving a protected resource
 * reachable while the pattern still looks right. Calling `requireUser()` inside
 * the page that reads the data cannot drift from that data.
 */

/** Signed-in user id, or a redirect to sign-in. */
export async function requireUser(): Promise<string> {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in')
  return userId
}

/** Signed-in user id, or null. For pages that render either way. */
export async function currentUser(): Promise<string | null> {
  const { userId } = await auth()
  return userId ?? null
}

/**
 * The caller's roles, from OUR table — never from Clerk metadata.
 *
 * Roles live in `user_roles` because they are our data: an administrator is
 * defined by a row we granted and audited, not by a claim in a token issued
 * elsewhere. Clerk says who you are; this says what you may do.
 *
 * Absence of a row IS "User" — there is no 'user' enum value, so an empty
 * array is the normal case rather than an error.
 */
export async function rolesOf(userId: string): Promise<AppRole[]> {
  const supabase = await createServerSupabase()
  const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', userId)
  if (error) return []
  return (data ?? []).map((r) => r.role)
}

export async function hasRole(role: AppRole): Promise<boolean> {
  const userId = await currentUser()
  if (!userId) return false
  return (await rolesOf(userId)).includes(role)
}

/**
 * Require one of `roles`, or redirect.
 *
 * Sends an unauthenticated visitor to sign-in but an authenticated-yet-
 * unauthorized one to /forbidden — because those are different situations and
 * "sign in" is useless advice to someone already signed in.
 */
export async function requireRole(...roles: AppRole[]): Promise<string> {
  const userId = await requireUser()
  const held = await rolesOf(userId)
  if (!roles.some((r) => held.includes(r))) redirect('/forbidden')
  return userId
}

export const requireStaff = () => requireRole('moderator', 'administrator')
export const requireAdmin = () => requireRole('administrator')
