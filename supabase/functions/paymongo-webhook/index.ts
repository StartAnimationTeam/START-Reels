import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'
import {
  isConfigured,
  verifyWebhookSignature,
  webhookSecretConfigured,
} from '../_shared/paymongo.ts'
import { claim, complete, release } from '../_shared/webhooks.ts'

/**
 * PayMongo → membership sync. The clerk-webhook skeleton with PayMongo's
 * signature scheme.
 *
 * Discipline (trap #10 + the 0029 doctrine):
 *   - verify the signature over the RAW body, never a re-stringified one
 *   - claim the EVENT id before any work; replays answer 200
 *   - ONLY a paid invoice extends membership time, and only through
 *     apply_subscription_payment — whose invoice-id unique key is the
 *     second idempotency layer (activated + invoice.paid can both carry
 *     the first invoice under different event ids)
 *   - past_due / unpaid / cancelled sync STATUS ONLY. Paid time is paid
 *     time; expiry is the only clawback.
 *   - unknown subscriptions get a 200 (someone else's test traffic must
 *     not burn PayMongo's 12 retries), logged for the curious.
 */

interface PaymongoEvent {
  data?: {
    id?: string
    attributes?: {
      type?: string
      livemode?: boolean
      // deno-lint-ignore no-explicit-any
      data?: any // the resource: subscription or invoice
    }
  }
}

// Tolerant field extraction — resource shapes get pinned by the live probe;
// every path here degrades to null rather than throwing.
// deno-lint-ignore no-explicit-any
function invoiceFields(resource: any): {
  invoiceId: string | null
  subscriptionId: string | null
  amount: number
  paidAt: string | null
} {
  const attrs = resource?.attributes ?? {}
  const rawPaid = attrs.paid_at ?? attrs.paidAt ?? null
  return {
    invoiceId: resource?.id ?? null,
    subscriptionId:
      attrs.subscription_id ?? attrs.subscription?.id ?? attrs.subscriptionId ?? null,
    amount: Number(attrs.amount ?? 0) || 0,
    paidAt: typeof rawPaid === 'number' ? new Date(rawPaid * 1000).toISOString() : rawPaid,
  }
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)
  if (!isConfigured() || !webhookSecretConfigured()) {
    // Fail closed but loudly — a 500 makes PayMongo retry, which is right:
    // the secret being absent is OUR misconfiguration, not a bad request.
    return fail(req, 'paymongo_not_configured', 500)
  }

  const raw = await req.text()
  const signature = req.headers.get('paymongo-signature')
  if (!signature) return fail(req, 'missing_signature', 400)
  if (!(await verifyWebhookSignature(raw, signature))) {
    return fail(req, 'invalid_signature', 401)
  }

  let event: PaymongoEvent
  try {
    event = JSON.parse(raw)
  } catch {
    return fail(req, 'bad_payload', 400)
  }

  const eventId = event.data?.id
  const eventType = event.data?.attributes?.type
  const resource = event.data?.attributes?.data
  if (!eventId || !eventType) return fail(req, 'bad_payload', 400)

  const db = serviceClient()

  const claimed = await claim(db, eventId, 'paymongo', eventType)
  if (claimed === 'already_processed') {
    return json(req, { ok: true, replay: true })
  }

  try {
    switch (eventType) {
      // ── membership passes: one-time hosted checkout (0030) ────────────
      case 'checkout_session.payment.paid': {
        const attrs = resource?.attributes ?? {}
        const meta = attrs.metadata ?? {}
        const userId = typeof meta.user_id === 'string' ? meta.user_id : null
        const tier = typeof meta.tier === 'string' ? meta.tier : null
        if (!userId || !tier) {
          // A session we didn't mint (console test, other tooling) — a
          // valid signature deserves a 200, not a retry storm.
          console.warn('checkout_session.payment.paid without our metadata', JSON.stringify(meta))
          break
        }
        // The SESSION id is the idempotency key: one session = one pass,
        // however many payment retries or webhook deliveries it took.
        const sessionId = resource?.id ?? null
        if (!sessionId) break
        const payments = Array.isArray(attrs.payments) ? attrs.payments : []
        const amount = Number(payments[0]?.attributes?.amount ?? attrs.line_items?.[0]?.amount ?? 0) || 0
        const { error } = await db.rpc('apply_subscription_payment', {
          p_user_id: userId,
          p_tier: tier,
          p_provider_subscription_id: null,
          p_provider_invoice_id: sessionId,
          p_amount_centavos: amount,
          p_paid_at: new Date().toISOString(),
        })
        if (error) throw new Error(`apply_subscription_payment(pass): ${error.message}`)
        break
      }

      case 'subscription.invoice.paid': {
        const inv = invoiceFields(resource)
        if (!inv.invoiceId || !inv.subscriptionId) {
          // A paid invoice we can't attribute is a payload-shape surprise —
          // log it loudly, still 200 (retrying won't reshape it).
          console.error('paymongo invoice.paid with missing ids', JSON.stringify(inv))
          break
        }
        const { data: sub } = await db
          .from('payment_subscriptions')
          .select('user_id, tier')
          .eq('provider_subscription_id', inv.subscriptionId)
          .maybeSingle()
        if (!sub) {
          console.warn(`paymongo invoice.paid for unknown subscription ${inv.subscriptionId}`)
          break
        }
        const { error } = await db.rpc('apply_subscription_payment', {
          p_user_id: sub.user_id,
          p_tier: sub.tier,
          p_provider_subscription_id: inv.subscriptionId,
          p_provider_invoice_id: inv.invoiceId,
          p_amount_centavos: inv.amount,
          p_paid_at: inv.paidAt ?? new Date().toISOString(),
        })
        if (error) throw new Error(`apply_subscription_payment: ${error.message}`)
        break
      }

      case 'subscription.activated': {
        const subId = resource?.id ?? null
        if (!subId) break
        const { data: sub } = await db
          .from('payment_subscriptions')
          .select('id, user_id, tier')
          .eq('provider_subscription_id', subId)
          .maybeSingle()
        if (!sub) {
          console.warn(`paymongo activated for unknown subscription ${subId}`)
          break
        }
        await db
          .from('payment_subscriptions')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('id', sub.id)

        // If the first invoice rides along, apply it — the invoice-unique
        // layer makes this safe whichever of activated/invoice.paid lands
        // first, or if both do.
        const embedded = resource?.attributes?.latest_invoice
        if (embedded?.id && (embedded.status === 'paid' || embedded.payment_intent?.status === 'succeeded')) {
          const { error } = await db.rpc('apply_subscription_payment', {
            p_user_id: sub.user_id,
            p_tier: sub.tier,
            p_provider_subscription_id: subId,
            p_provider_invoice_id: embedded.id,
            p_amount_centavos: Number(embedded.amount ?? 0) || 0,
            p_paid_at: new Date().toISOString(),
          })
          if (error) throw new Error(`apply_subscription_payment: ${error.message}`)
        }
        break
      }

      case 'subscription.past_due':
      case 'subscription.unpaid':
      case 'subscription.updated': {
        const subId = resource?.id ?? null
        if (!subId) break
        const remoteStatus = String(resource?.attributes?.status ?? '')
        const allowed = ['incomplete', 'incomplete_cancelled', 'active', 'past_due', 'unpaid', 'cancelled']
        const status = eventType === 'subscription.past_due'
          ? 'past_due'
          : eventType === 'subscription.unpaid'
            ? 'unpaid'
            : allowed.includes(remoteStatus) ? remoteStatus : null
        if (!status) break
        // STATUS ONLY — memberships.expires_at is deliberately untouched.
        await db
          .from('payment_subscriptions')
          .update({
            status,
            updated_at: new Date().toISOString(),
            ...(status === 'cancelled' ? { cancelled_at: new Date().toISOString() } : {}),
          })
          .eq('provider_subscription_id', subId)
        break
      }

      case 'subscription.invoice.payment_failed': {
        // The retry ladder is PayMongo's; past_due/unpaid arrive as their
        // own events. Nothing to do beyond the claim row recording it.
        break
      }

      default:
        // Unknown event type: claimed, acknowledged, ignored.
        break
    }

    await complete(db, eventId)
    return json(req, { ok: true })
  } catch (err) {
    await release(db, eventId, err)
    console.error(`paymongo-webhook ${eventType} failed:`, err)
    return fail(req, 'processing_failed', 500)
  }
})
