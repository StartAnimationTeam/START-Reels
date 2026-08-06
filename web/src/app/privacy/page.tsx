import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Privacy Policy' }

/**
 * Static privacy policy — a Google AdSense/Ad Manager approval prerequisite
 * (Phase B of the ads plan) and simply owed to users regardless. Publicly
 * reachable, no auth. Update "Last updated" whenever the substance changes.
 */
export default function PrivacyPage() {
  const h2 = 'mt-8 text-base font-semibold text-ink'
  const p = 'mt-2 text-sm leading-relaxed text-ink-secondary'

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Privacy Policy</h1>
      <p className="mt-1 text-xs text-ink-faint">START LANDS Inc. · Last updated August 6, 2026</p>

      <p className={p}>
        START Reels is a video streaming service operated by START LANDS Inc.
        This page explains what we collect, why, and the choices you have.
      </p>

      <h2 className={h2}>What we collect</h2>
      <p className={p}>
        <strong>Account data.</strong> When you sign up, our sign-in provider
        (Clerk) collects your email address and, if you provide them, a display
        name and avatar. We store a copy of that profile alongside your
        watching activity.
      </p>
      <p className={p}>
        <strong>Activity data.</strong> To make the product work we record what
        you watch and for how long, the episodes you unlock, your coin balance
        and coin history, your likes, saves, and follows, and rewards you claim
        (daily check-ins and rewarded ads).
      </p>
      <p className={p}>
        <strong>Technical data.</strong> Like most services we receive your IP
        address, browser type, and device information with each request, and we
        use cookies and similar technologies to keep you signed in and to keep
        the service secure.
      </p>

      <h2 className={h2}>Advertising</h2>
      <p className={p}>
        We show optional <strong>rewarded ads</strong> — short videos you
        choose to watch in exchange for coins. Ads are served by Google
        (Google Ad Manager / AdMob). Google may use cookies or device
        advertising identifiers to serve and measure ads; where required (for
        example in the EEA, the UK, and Switzerland), you will be asked for
        consent before any ad personalization happens, and you can decline.
        You can also simply never tap the ad button — ads are never forced
        into playback.
      </p>
      <p className={p}>
        Google&rsquo;s use of advertising data is described in{' '}
        <a
          href="https://policies.google.com/technologies/ads"
          className="underline decoration-line-strong underline-offset-2 hover:text-ink"
          rel="noopener noreferrer"
          target="_blank"
        >
          Google&rsquo;s advertising policies
        </a>
        .
      </p>

      <h2 className={h2}>How we use data</h2>
      <p className={p}>
        To run the service (playback, unlocks, coin accounting, resume
        position), to prevent abuse (rate limits, duplicate reward claims), to
        understand what content performs well in aggregate, and to comply with
        legal obligations. We do not sell your personal information.
      </p>

      <h2 className={h2}>Sharing</h2>
      <p className={p}>
        We share data only with the processors that operate the service:
        Clerk (sign-in), Supabase (database), Bunny.net (video delivery),
        Vercel (hosting), and Google (advertising). Each receives only what its
        role requires.
      </p>

      <h2 className={h2}>Retention and deletion</h2>
      <p className={p}>
        We keep your data while your account exists. To delete your account
        and its data, contact us at the address below and we will process the
        request within 30 days.
      </p>

      <h2 className={h2}>Children</h2>
      <p className={p}>
        START Reels is not directed at children under 13, and we do not
        knowingly collect data from them.
      </p>

      <h2 className={h2}>Contact</h2>
      <p className={p}>
        START LANDS Inc. ·{' '}
        <a
          href="mailto:jonathan@startlands.com"
          className="underline decoration-line-strong underline-offset-2 hover:text-ink"
        >
          jonathan@startlands.com
        </a>
      </p>
    </div>
  )
}
