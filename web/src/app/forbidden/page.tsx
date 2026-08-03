import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Not permitted' }

/**
 * A permission boundary must SAY SO.
 *
 * Rendering nothing where a control belongs reads as a broken page — that is
 * how the sibling project's missing approval buttons were first reported, as a
 * bug rather than as the deliberate restriction they were. Someone who is
 * already signed in and lacks a role needs to be told that, not bounced to a
 * sign-in form they have no use for. (CLAUDE.md trap #15)
 */
export default function ForbiddenPage() {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-lg flex-col justify-center px-4">
      <h1 className="text-2xl font-semibold tracking-tight">You don’t have access to this</h1>
      <p className="mt-3 text-ink-secondary">
        You’re signed in, but this area needs a role your account doesn’t have.
        If you think that’s wrong, ask an administrator to check your
        permissions.
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/"
          className="rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: 'var(--brand-gradient)' }}
        >
          Back home
        </Link>
        <Link
          href="/me"
          className="rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary transition-colors hover:border-brand hover:text-ink"
        >
          Your profile
        </Link>
      </div>
    </div>
  )
}
