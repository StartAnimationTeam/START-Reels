import type { Metadata } from 'next'
import { SignUp } from '@clerk/nextjs'

export const metadata: Metadata = { title: 'Create an account' }

/**
 * Catch-all so Clerk owns /sign-up/verify-email-address — the email
 * verification step. Signup grants credits (see the clerk-webhook function), so
 * verification is enforced in the Clerk dashboard rather than left optional:
 * unverified signups are how a public platform's daily-reward credits get
 * farmed by bots.
 */
export default function SignUpPage() {
  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-8 px-4 py-12">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/logo-stack.png" alt="START Reels" className="h-14 w-auto" />
      <SignUp />
    </div>
  )
}
