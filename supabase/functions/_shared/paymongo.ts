/**
 * THE ONLY FILE THAT KNOWS PAYMONGO EXISTS.
 *
 * Everything else deals in memberships rows and payment_subscriptions
 * statuses. Same doctrine as bunny.ts: deliberately a handful of plain
 * functions, not a provider-adapter registry.
 *
 * Configuration (supabase/.env → `supabase secrets set`, one name at a time):
 *   PAYMONGO_SECRET_KEY       sk_test_… / sk_live_…  (Basic auth username)
 *   PAYMONGO_WEBHOOK_SECRET   whsk from webhook registration (paymongo-setup
 *                             prints it; signature verification is dead
 *                             until it is set)
 *
 * Mode is DERIVED from the secret key prefix — no separate MODE variable to
 * drift out of sync. Plan ids live in platform_settings.paymongo_plans as
 * {"test": {...}, "live": {...}}; callers pick the branch via mode().
 *
 * Two hosts, per the docs: subscriptions & plans ride a dedicated service.
 */

const SECRET_KEY = Deno.env.get('PAYMONGO_SECRET_KEY')
const WEBHOOK_SECRET = Deno.env.get('PAYMONGO_WEBHOOK_SECRET')

const API_BASE = 'https://api.paymongo.com/v1'
const SUBS_BASE = 'https://subscriptions-go-api.paymongo.com/v1'

export function isConfigured(): boolean {
  return Boolean(SECRET_KEY)
}

export function webhookSecretConfigured(): boolean {
  return Boolean(WEBHOOK_SECRET)
}

export function mode(): 'test' | 'live' {
  return SECRET_KEY?.startsWith('sk_live_') ? 'live' : 'test'
}

function authHeader(): string {
  // Basic auth: secret key as username, empty password.
  return `Basic ${btoa(`${SECRET_KEY}:`)}`
}

async function api(base: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`paymongo_api_error: ${res.status} ${text.slice(0, 500)}`)
  }
  return text ? JSON.parse(text) : null
}

/** JSON:API unwrap — every PayMongo resource arrives as { data: {...} }. */
// deno-lint-ignore no-explicit-any
function unwrap(body: unknown): any {
  return (body as { data: unknown })?.data
}

export interface PaymongoSubscription {
  id: string
  status: string
  latestInvoice: {
    id: string | null
    status: string | null
    paymentIntentId: string | null
    paymentIntentStatus: string | null
  }
  nextActionUrl: string | null
}

// deno-lint-ignore no-explicit-any
function toSubscription(data: any): PaymongoSubscription {
  const attrs = data?.attributes ?? {}
  const invoice = attrs.latest_invoice ?? {}
  return {
    id: data?.id,
    status: attrs.status ?? 'unknown',
    latestInvoice: {
      id: invoice.id ?? null,
      status: invoice.status ?? null,
      paymentIntentId: invoice.payment_intent?.id ?? null,
      paymentIntentStatus: invoice.payment_intent?.status ?? null,
    },
    nextActionUrl: attrs.setup_intent?.next_action_url ?? null,
  }
}

export async function createCustomer(email: string, name: string | null): Promise<string> {
  const body = await api(API_BASE, '/customers', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        attributes: {
          email,
          first_name: name?.split(' ')[0] || 'START',
          last_name: name?.split(' ').slice(1).join(' ') || 'Viewer',
          default_device: 'email',
        },
      },
    }),
  })
  return unwrap(body).id
}

export async function createSubscription(customerId: string, planId: string): Promise<PaymongoSubscription> {
  const body = await api(SUBS_BASE, '/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ data: { attributes: { customer_id: customerId, plan_id: planId } } }),
  })
  return toSubscription(unwrap(body))
}

export async function getSubscription(id: string): Promise<PaymongoSubscription> {
  return toSubscription(unwrap(await api(SUBS_BASE, `/subscriptions/${id}`)))
}

export async function cancelSubscription(id: string): Promise<PaymongoSubscription> {
  return toSubscription(unwrap(await api(SUBS_BASE, `/subscriptions/${id}/cancel`, { method: 'POST' })))
}

/** Simulates a renewal invoice. TEST MODE ONLY — live calls must never reach it. */
export async function triggerTestCycle(id: string): Promise<PaymongoSubscription> {
  if (mode() === 'live') throw new Error('test_cycle_is_test_mode_only')
  return toSubscription(unwrap(await api(SUBS_BASE, `/subscriptions/${id}/test_cycle`, { method: 'POST' })))
}

// deno-lint-ignore no-explicit-any
export async function getPaymentIntent(id: string): Promise<any> {
  return unwrap(await api(API_BASE, `/payment_intents/${id}`))
}

/** Plan ids + display prices for the CURRENT mode, from platform_settings. */
export interface PlanConfig {
  planId: string
  amountCentavos: number
}
// deno-lint-ignore no-explicit-any
export function plansForMode(settingValue: any): Record<string, PlanConfig> | null {
  const branch = settingValue?.[mode()]
  if (!branch) return null
  return branch as Record<string, PlanConfig>
}

/**
 * Paymongo-Signature: t=<ts>,te=<test sig>,li=<live sig>
 * Verify HMAC-SHA256(secret, `${t}.${rawBody}`) against te (test) or li
 * (live), by mode(). Constant-time comparison on the digest bytes.
 */
export async function verifyWebhookSignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!WEBHOOK_SECRET || !header) return false

  const parts = new Map<string, string>()
  for (const piece of header.split(',')) {
    const idx = piece.indexOf('=')
    if (idx > 0) parts.set(piece.slice(0, idx).trim(), piece.slice(idx + 1).trim())
  }
  const t = parts.get('t')
  const given = parts.get(mode() === 'live' ? 'li' : 'te')
  if (!t || !given) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)),
  )
  const expected = Array.from(mac).map((b) => b.toString(16).padStart(2, '0')).join('')

  if (expected.length !== given.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
  }
  return diff === 0
}
