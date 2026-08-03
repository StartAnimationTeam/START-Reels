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
  signup_grant: 'Welcome credits',
  daily_reward: 'Daily reward',
  promo: 'Promotional credits',
  admin_grant: 'Granted by an administrator',
  watch_debit: 'Unlocked a video',
  refund: 'Refunded',
  manual_adjustment: 'Adjustment',
  top_up: 'Purchased credits',
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
  insufficient_credits: 'You don’t have enough credits to unlock this video',
  needs_unlock: 'Unlock this video to start watching.',
  too_many_streams: 'This video is already playing on your other devices. Stop one to continue here.',
  forbidden: 'You don’t have permission to do that.',
  not_found: 'We couldn’t find that.',
  video_not_published: 'This video isn’t available right now.',
  account_suspended: 'Your account is suspended. Contact support if you think this is a mistake.',
  account_banned: 'Your account has been closed.',
  upload_too_large: 'That file is too large. Check the size limit on the upload page.',
  upload_too_long: 'That video is longer than the limit for uploads.',
  already_claimed_today: 'You’ve already claimed today’s credits. Come back tomorrow.',
  promo_expired: 'That code has expired.',
  promo_already_redeemed: 'You’ve already used that code.',
  maintenance_mode: 'START Video Library is down for maintenance. We’ll be back shortly.',
  rate_limited: 'Too many requests. Give it a moment and try again.',
  cannot_moderate_self: 'You can’t suspend or ban your own account.',
  cannot_demote_self: 'You can’t remove your own administrator role — ask another administrator.',
  upload_create_failed: 'Couldn’t start the upload. Try again in a moment.',
  upload_failed: 'The upload failed partway. Choosing the same file will resume it.',
  video_not_ready: 'This video hasn’t finished processing yet.',
  tier_cost_mismatch: 'That price doesn’t match the tier: free is 0, premium is 1, exclusive is 2–5.',
  ledger_hold_not_found_or_already_settled: 'That charge was already settled.',
}

export function errorLabel(code: string | null | undefined): string {
  if (!code) return 'Something went wrong. Please try again.'

  // DB exceptions arrive as "insufficient_credits: have 0, need 1" — match the
  // code before the colon so the numbers never reach the user.
  const key = code.split(':')[0].trim()
  return ERROR_MESSAGES[key] ?? 'Something went wrong. Please try again.'
}

/** Credits are whole numbers in the UI even though the ledger stores numeric. */
export function creditLabel(amount: number): string {
  const n = Math.abs(amount)
  const rounded = Number.isInteger(n) ? n : Math.round(n * 100) / 100
  return `${rounded} ${rounded === 1 ? 'credit' : 'credits'}`
}

export function tierCostLabel(tier: string, cost: number): string {
  if (tier === 'free' || cost === 0) return 'Free'
  return creditLabel(cost)
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
