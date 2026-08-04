import { redirect } from 'next/navigation'

/** Watch history lives at /profile/history since the pivot. */
export default function HistoryPage() {
  redirect('/profile/history')
}
