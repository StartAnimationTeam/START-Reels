import Link from 'next/link'
// Clerk v7 removed <SignedIn>/<SignedOut> in favour of <Show when="…">.
import { Show } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'

import { createServerSupabase } from '@/lib/supabase-server'

export default async function HomePage() {
  const { userId } = await auth()

  return (
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
      <section className="animate-rise max-w-3xl">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          The START <span className="brand-gradient-text">Video Library</span>
        </h1>
        <p className="mt-4 text-lg text-ink-secondary">
          Stream the in-house catalogue. Free titles cost nothing; premium and
          exclusive titles unlock with credits, and an unlock lasts 48 hours —
          rewatch, seek and switch devices as much as you like.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/browse"
            className="rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform hover:scale-[1.02]"
            style={{ background: 'var(--brand-gradient)' }}
          >
            Browse the library
          </Link>
          <Show when="signed-out">
            <Link
              href="/sign-up"
              className="rounded-lg border border-line-strong px-5 py-2.5 text-sm font-medium text-ink-secondary transition-colors hover:border-brand hover:text-ink"
            >
              Create an account
            </Link>
          </Show>
        </div>
      </section>

      <Show when="signed-in">
        <SetupStatus userId={userId} />
      </Show>
    </div>
  )
}

/**
 * Phase 0 build status.
 *
 * Temporary scaffolding — replaced by the featured / continue-watching /
 * category rails in Phase 3. It exists now because "did the Clerk↔Supabase
 * third-party auth integration actually get switched on?" is invisible
 * otherwise: RLS returns an empty array rather than an error when it is off
 * (CLAUDE.md trap #6), so a broken integration and a brand-new account look
 * identical. This surfaces the difference instead of hiding it.
 */
async function SetupStatus({ userId }: { userId: string | null }) {
  let supabaseReachable = false
  let schemaApplied = false
  let detail = ''

  try {
    const supabase = await createServerSupabase()
    const { error } = await supabase.from('platform_settings').select('key').limit(1)

    supabaseReachable = true
    if (error) {
      detail = error.message
    } else {
      schemaApplied = true
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err)
  }

  const checks = [
    {
      label: 'Clerk session',
      ok: Boolean(userId),
      note: userId ? 'Signed in' : 'Not signed in',
    },
    {
      label: 'Supabase reachable',
      ok: supabaseReachable,
      note: supabaseReachable ? 'Connected' : 'Not configured',
    },
    {
      label: 'Schema applied',
      ok: schemaApplied,
      note: schemaApplied ? 'Migrations present' : detail || 'Run the migrations',
    },
  ]

  return (
    <section className="animate-fade mt-16 max-w-xl rounded-xl border border-line bg-surface p-6">
      <h2 className="text-sm font-medium text-ink-secondary">Phase 0 — setup status</h2>
      <ul className="mt-4 space-y-3">
        {checks.map((check) => (
          <li key={check.label} className="flex items-center gap-3 text-sm">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: check.ok ? 'var(--success)' : 'var(--text-faint)' }}
            />
            <span className="text-ink">{check.label}</span>
            <span className="ml-auto max-w-[60%] truncate text-xs text-ink-muted" title={check.note}>
              {check.note}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-ink-faint">
        Phase 0 scaffolding — removed in Phase 3.
      </p>
    </section>
  )
}
