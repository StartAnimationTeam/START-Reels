/**
 * Human-readable text for every machine value.
 *
 * The rule: NOTHING RAW REACHES THE SCREEN. No enum, no error code, no
 * `insufficient_credits` string. A user seeing `ledger_hold_not_found_or_
 * already_settled` learns nothing and reports nothing useful.
 *
 * The sharper reason (CLAUDE.md trap #15): a permission boundary must SAY SO.
 * Rendering nothing where a control belongs reads as a broken page — that is
 * how the sibling project's missing approval buttons were first reported, as a
 * bug rather than as the deliberate restriction they were.
 */

export const ROLE_LABELS: Record<string, string> = {
  creator: 'Creator',
  moderator: 'Moderator',
  administrator: 'Administrator',
}

/** Absence of a role row IS "User" — there is no 'user' enum value. */
export function roleLabel(roles: string[]): string {
  if (roles.includes('administrator')) return ROLE_LABELS.administrator
  if (roles.includes('moderator')) return ROLE_LABELS.moderator
  if (roles.includes('creator')) return ROLE_LABELS.creator
  return 'User'
}

export const LEDGER_REASON_LABELS: Record<string, string> = {
  signup_grant: 'Welcome coins',
  daily_reward: 'Check-in reward',
  promo: 'Promo coins',
  admin_grant: 'Granted by an administrator',
  watch_debit: 'Unlocked an episode',
  refund: 'Refunded',
  manual_adjustment: 'Adjustment',
  top_up: 'Purchased coins',
}

/** The bottom tab bar. Order is the bar's order. */
export const NAV_LABELS = {
  home: 'Home',
  feed: 'For You',
  member: 'Member',
  myList: 'My List',
  profile: 'Profile',
} as const

export const SERIES_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  published: 'Published',
  removed: 'Removed',
}

/** "EP.3" — the DramaBox register, used on chips and progress lines. */
export function episodeLabel(n: number): string {
  return `EP.${n}`
}

/** "EP.7 / EP.55" — where the viewer is against the whole run. */
export function episodeProgressLabel(current: number, total: number): string {
  return `${episodeLabel(current)} / ${episodeLabel(total)}`
}

/**
 * Membership is a SHELL until payments exist. The boundary must say so
 * (trap #15): a visible "coming soon", never a dead Join button.
 */
export const MEMBERSHIP_COMING_SOON =
  'Memberships are coming soon. Until then, every episode unlocks with coins.'

export const MEMBER_TIER_LABELS: Record<string, string> = {
  weekly: 'Weekly Membership',
  annual: 'Annual Membership',
}

export const LEDGER_STATUS_LABELS: Record<string, string> = {
  pending: 'On hold',
  committed: 'Settled',
  reversed: 'Refunded',
}

export const ACCESS_TIER_LABELS: Record<string, string> = {
  free: 'Free',
  premium: 'Premium',
  exclusive: 'Exclusive',
}

export const VIDEO_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  uploading: 'Uploading',
  processing: 'Processing',
  pending_review: 'Awaiting review',
  published: 'Published',
  rejected: 'Rejected',
  removed: 'Removed',
}

/**
 * Server and database errors, translated.
 *
 * `insufficient_credits` deliberately does not end in a full stop — the UI
 * follows it with a top-up action, and a sentence that ends closes the door on
 * the thing the user should do next.
 */
const ERROR_MESSAGES: Record<string, string> = {
  insufficient_credits: 'You don’t have enough coins to unlock this episode',
  needs_unlock: 'Unlock this episode to start watching.',
  too_many_streams: 'This is already playing on your other devices. Stop one to continue here.',
  forbidden: 'You don’t have permission to do that.',
  not_found: 'We couldn’t find that.',
  video_not_published: 'This episode isn’t available right now.',
  episode_number_taken: 'That episode number is already used in this series.',
  category_exists: 'A category with that name already exists.',
  banner_required: 'Featuring needs a wide banner first — upload one in Curation.',
  ad_rewards_disabled: 'Ad rewards are paused right now.',
  ad_reward_cap_reached: 'You’ve hit today’s ad limit — come back tomorrow.',
  ad_reward_too_soon: 'One at a time — give it a few seconds and try again.',
  ad_no_fill: 'No ad is available right now. Try again in a bit.',
  tag_exists: 'A facet with that name already exists.',
  series_not_ready: 'Publish at least one episode before publishing the series.',
  series_not_found: 'We couldn’t find that series.',
  account_suspended: 'Your account is suspended. Contact support if you think this is a mistake.',
  account_banned: 'Your account has been closed.',
  upload_too_large: 'That file is too large. Check the size limit on the upload page.',
  upload_too_long: 'That video is longer than the limit for uploads.',
  already_claimed_today: 'You’ve already claimed today’s credits. Come back tomorrow.',
  promo_expired: 'That code has expired.',
  promo_already_redeemed: 'You’ve already used that code.',
  promo_invalid: 'That code isn’t valid.',
  promo_exhausted: 'That code has been fully claimed.',
  daily_reward_disabled: 'Daily rewards are paused right now.',
  maintenance_mode: 'START Video Library is down for maintenance. We’ll be back shortly.',
  rate_limited: 'Too many requests. Give it a moment and try again.',
  cannot_moderate_self: 'You can’t suspend or ban your own account.',
  cannot_demote_self: 'You can’t remove your own administrator role — ask another administrator.',
  upload_create_failed: 'Couldn’t start the upload. Try again in a moment.',
  upload_failed: 'The upload failed partway. Choosing the same file will resume it.',
  video_not_ready: 'This video hasn’t finished processing yet.',
  tier_cost_mismatch: 'That price doesn’t match the tier: free is 0, paid tiers are 1–20.',
  ledger_hold_not_found_or_already_settled: 'That charge was already settled.',
}

export function errorLabel(code: string | null | undefined): string {
  if (!code) return 'Something went wrong. Please try again.'

  // DB exceptions arrive as "insufficient_credits: have 0, need 1" — match the
  // code before the colon so the numbers never reach the user.
  const key = code.split(':')[0].trim()
  return ERROR_MESSAGES[key] ?? 'Something went wrong. Please try again.'
}

/**
 * The currency is "coins" EVERYWHERE users see it — a labels-layer rename
 * only; the database stays credit_* end to end. Whole numbers in the UI even
 * though the ledger stores numeric.
 */
export function creditLabel(amount: number): string {
  const n = Math.abs(amount)
  const rounded = Number.isInteger(n) ? n : Math.round(n * 100) / 100
  return `${rounded} ${rounded === 1 ? 'coin' : 'coins'}`
}

export function tierCostLabel(tier: string, cost: number): string {
  if (tier === 'free' || cost === 0) return 'Free'
  return creditLabel(cost)
}

/** Pricing line for a series card/detail: how the free window reads. */
export function seriesPricingLabel(freeCount: number, cost: number): string {
  if (cost === 0) return 'Free'
  if (freeCount <= 0) return `${creditLabel(cost)} per episode`
  return `First ${freeCount === 1 ? 'episode' : `${freeCount} episodes`} free · then ${creditLabel(cost)} each`
}

/**
 * "Premieres Aug 12, 8:00 PM" — the Coming Soon promise. Viewer-facing
 * surfaces omit timeZone (their local premiere moment is the honest one);
 * ADMIN surfaces pass the platform zone so scheduling reads in PH time with
 * the zone named (trap #17: never the device clock by accident).
 */
export function comingSoonLabel(iso: string, timeZone?: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return 'Coming soon'
  const opts = timeZone ? { timeZone } : {}
  const zone = timeZone
    ? ` (${new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
        .formatToParts(when)
        .find((p) => p.type === 'timeZoneName')?.value ?? timeZone})`
    : ''
  return `Premieres ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...opts })}, ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...opts })}${zone}`
}

/** "19.5K", "1M", "842" — the play-count badge, DramaBox-compact. */
export function viewsLabel(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`
  }
  if (n >= 1_000) {
    const k = n / 1_000
    return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}K`
  }
  return String(n)
}

/** "2h 14m", "8m 03s", "44s" — never a bare seconds count. */
export function durationLabel(totalSeconds: number | null | undefined): string {
  if (!totalSeconds || totalSeconds < 0) return '—'
  const s = Math.floor(totalSeconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}
