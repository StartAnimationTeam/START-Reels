import { AuthError, ipHash, requireUser } from '../_shared/auth.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST { claimToken } — the WEB door of the rewarded-ad rail.
 *
 * Google's web rewarded ads (GPT) have NO server-side verification — that
 * is an app-only feature — so the strongest signal the web can ever offer
 * is "an authenticated user's page fired rewardedSlotGranted". This
 * endpoint is honest about that ceiling: the claim is Clerk-authenticated,
 * the claimToken (client-minted UUID per ad load) makes double-fires and
 * fetch retries idempotent, and grant_ad_reward bounds any abuse at
 * daily_cap × amount coins per day with a min-interval guard.
 *
 * The native AdMob door (ads-ssv) verifies Google's signature instead —
 * same rail, stronger lock.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)

  let userId: string
  try {
    userId = await requireUser(req)
  } catch (err) {
    return fail(req, err instanceof AuthError ? err.code : 'unauthorized', 401)
  }

  let claimToken: string
  try {
    const body = await req.json()
    claimToken = String(body?.claimToken ?? '')
  } catch {
    return fail(req, 'bad_request', 400)
  }
  if (!UUID.test(claimToken)) return fail(req, 'bad_request', 400)

  const db = serviceClient()
  const { data, error } = await db.rpc('grant_ad_reward', {
    p_user_id: userId,
    p_provider: 'gpt_web',
    p_transaction_id: claimToken.toLowerCase(),
    p_metadata: { origin: 'web', ip_hash: await ipHash(req) },
  })

  if (error) {
    const code = error.message.split(':')[0].trim()
    if (code === 'ad_rewards_disabled') return fail(req, code, 409)
    if (code === 'ad_reward_cap_reached') return fail(req, code, 429)
    if (code === 'ad_reward_too_soon') return fail(req, code, 429)
    if (code === 'bad_request') return fail(req, code, 400)
    return fail(req, 'update_failed', 500, error.message)
  }

  return json(req, data)
})
