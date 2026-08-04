import { redirect } from 'next/navigation'

/**
 * /browse belonged to the pre-pivot library. Its job — "show me everything,
 * grouped" — is the home page's Categories tab now; the redirect keeps every
 * old link and bookmark meaning something.
 */
export default function BrowsePage() {
  redirect('/?tab=categories')
}
