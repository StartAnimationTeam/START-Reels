import Link from 'next/link'
// Clerk v7 removed <SignedIn>/<SignedOut> in favour of <Show when="…">.
import { Show, SignInButton, UserButton } from '@clerk/nextjs'

import { CreditBadge } from './CreditBadge'
import { SearchLauncher } from './SearchLauncher'

/**
 * The slim top bar. Primary navigation lives in the bottom tab bar since the
 * pivot — this keeps only identity (logo), search, and the account corner.
 */
export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-background/85 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden
            className="h-5 w-5 rounded-full"
            style={{ background: 'var(--brand-gradient)' }}
          />
          <span>START</span>
          <span className="brand-gradient-text">Reels</span>
        </Link>

        <div className="ml-auto flex items-center gap-3">
          <SearchLauncher variant="icon" />

          <Show when="signed-in">
            <CreditBadge />
            <UserButton appearance={{ elements: { avatarBox: 'h-8 w-8' } }} />
          </Show>

          <Show when="signed-out">
            <SignInButton mode="modal">
              <button className="rounded-lg px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:text-ink">
                Sign in
              </button>
            </SignInButton>
            <Link
              href="/sign-up"
              className="rounded-lg px-3.5 py-1.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform hover:scale-[1.02]"
              style={{ background: 'var(--brand-gradient)' }}
            >
              Sign up
            </Link>
          </Show>
        </div>
      </nav>
    </header>
  )
}
