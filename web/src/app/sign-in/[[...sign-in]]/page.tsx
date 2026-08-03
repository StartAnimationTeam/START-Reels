import type { Metadata } from 'next'
import { SignIn } from '@clerk/nextjs'

export const metadata: Metadata = { title: 'Sign in' }

/**
 * Catch-all segment so Clerk can own its sub-routes — /sign-in/factor-one,
 * /sign-in/reset-password, and the rest of the forgot-password flow. Without
 * the [[...sign-in]] catch-all those 404 and password reset silently breaks.
 */
export default function SignInPage() {
  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4 py-12">
      <SignIn />
    </div>
  )
}
