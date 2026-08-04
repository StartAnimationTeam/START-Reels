import { redirect } from 'next/navigation'

/**
 * Placeholder until the profile hub lands (pivot Phase 5): the bottom tab
 * needs a stable /profile URL from day one, and /me is the same information
 * today. Phase 5 inverts this — the hub moves HERE and /me redirects.
 */
export default function ProfilePage() {
  redirect('/me')
}
