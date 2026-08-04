import { redirect } from 'next/navigation'

/** /me moved to /profile with the pivot; the redirect keeps old links alive. */
export default function MePage() {
  redirect('/profile')
}
