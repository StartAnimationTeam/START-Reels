import { AuthError, requireUser } from '../_shared/auth.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'
import { isConfigured, mode } from '../_shared/paymongo.ts'

/**
 * POST { tier } — mint a hosted-checkout session for a MEMBERSHIP PASS:
 * one payment, 7/30/365 days on the memberships row. No auto-renew — QRPh
 * (the one live-approved method) cannot recur, and the UI says so.
 *
 * The grant NEVER happens here. PayMongo's checkout_session.payment.paid
 * webhook carries our {user_id, tier} metadata back and the webhook calls
 * apply_subscription_payment with the SESSION id as the invoice key —
 * webhook-driven because a QR payer may scan from another phone and never
 * return to the browser. This endpoint only prices and mints the session.
 *
 * Everything configurable rides platform_settings (0030):
 *   membership_passes_enabled  the master switch (honest Coming-soon off)
 *   membership_pass_prices     centavos by tier
 *   membership_pass_methods    payment_method_types offered — test mode
 *                              takes all; live gets trimmed to what's Active
 */

const TIERS = ['weekly', 'monthly', 'annual'] as const
type Tier = (typeof TIERS)[number]

const TIER_NAMES: Record<Tier, string> = {
  weekly: 'Weekly Membership Pass (7 days)',
  monthly: 'Monthly Membership Pass (30 days)',
  annual: 'Annual Membership Pass (365 days)',
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)
  if (!isConfigured()) return fail(req, 'paymongo_not_configured', 503)

  let userId: string
  try {
    userId = await requireUser(req)
  } catch (err) {
    return fail(req, err instanceof AuthError ? err.code : 'unauthorized', 401)
  }

  let tier: Tier
  try {
    const body = await req.json()
    tier = body?.tier
  } catch {
    return fail(req, 'bad_request', 400)
  }
  if (!TIERS.includes(tier)) return fail(req, 'bad_request', 400)

  const db = serviceClient()

  const { data: settings } = await db
    .from('platform_settings')
    .select('key, value')
    .in('key', ['membership_passes_enabled', 'membership_pass_prices', 'membership_pass_methods'])
  const setting = (k: string) => settings?.find((s) => s.key === k)?.value

  if (setting('membership_passes_enabled') !== true) {
    return fail(req, 'passes_disabled', 409)
  }
  const prices = setting('membership_pass_prices') as Record<string, number> | undefined
  const amount = Number(prices?.[tier] ?? 0)
  if (!Number.isInteger(amount) || amount < 100) {
    return fail(req, 'paymongo_not_configured', 503, `no price for ${tier}`)
  }
  const methods = setting('membership_pass_methods')
  const paymentMethods = Array.isArray(methods) && methods.length > 0
    ? methods.map(String)
    : ['qrph']

  // The origin the user came from is where they return to — it is already
  // allowlisted by CORS or the request wouldn't be here.
  const origin = req.headers.get('origin') ?? 'https://startreels.com'

  const auth = `Basic ${btoa(`${Deno.env.get('PAYMONGO_SECRET_KEY')}:`)}`
  const res = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: {
        attributes: {
          line_items: [{
            name: TIER_NAMES[tier],
            amount,
            currency: 'PHP',
            quantity: 1,
            description: 'START Reels — every episode unlocked while your pass is active.',
          }],
          payment_method_types: paymentMethods,
          success_url: `${origin}/member?paid=1`,
          cancel_url: `${origin}/member`,
          description: TIER_NAMES[tier],
          reference_number: `pass-${tier}-${userId.slice(-8)}-${Date.now()}`,
          statement_descriptor: 'START Reels',
          send_email_receipt: true,
          show_line_items: true,
          // THE LINK BACK: the webhook grants from exactly this metadata.
          metadata: { user_id: userId, tier, app: 'start-reels', kind: 'membership_pass' },
        },
      },
    }),
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    console.error('checkout_session create failed:', res.status, JSON.stringify(body)?.slice(0, 500))
    return fail(req, 'payment_failed', 502)
  }

  return json(req, {
    checkoutUrl: body.data.attributes.checkout_url,
    sessionId: body.data.id,
    amount,
    tier,
    testMode: mode() === 'test',
  })
})
