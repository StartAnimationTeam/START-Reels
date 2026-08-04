import { redirect } from 'next/navigation'

/** The wallet lives at /profile/wallet since the pivot. */
export default function CreditsPage() {
  redirect('/profile/wallet')
}
