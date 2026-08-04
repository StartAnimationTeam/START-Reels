import { redirect } from 'next/navigation'

/** Settings live at /profile/settings since the pivot. */
export default function SettingsPage() {
  redirect('/profile/settings')
}
