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
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-8 px-4 py-12">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/logo-stack.png" alt="START Reels" className="h-14 w-auto" />
      <SignIn />
    </div>
  )
}
