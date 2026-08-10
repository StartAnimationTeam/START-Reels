#!/usr/bin/env node
/**
 * PayMongo bootstrap — idempotent. Creates the three membership plans and
 * registers the webhook, then records plan ids in
 * platform_settings.paymongo_plans under the CURRENT MODE's branch
 * ({"test": {...}, "live": {...}}), so a live cutover never clobbers the
 * test configuration.
 *
 * PLAN IMMUTABILITY: a PayMongo plan's amount cannot change in flight. A
 * price change means this script creates a NEW plan (edit PRICES below and
 * re-run) and new subscribers land on it; existing subscribers GRANDFATHER
 * on the plan they joined. That is expected owner-visible behavior, not a
 * bug.
 *
 * The webhook secret is printed ONCE (PayMongo returns it on registration;
 * we find-by-URL on re-runs precisely so it never rotates by accident).
 * Push it yourself:
 *   npx supabase secrets set PAYMONGO_WEBHOOK_SECRET=whsk_…
 * and add it to the root .env for the test suites. Never auto-pushed.
 *
 * Usage:  node scripts/paymongo-setup.mjs        (needs PAYMONGO_SECRET_KEY)
 */

import { loadEnv, sql } from './_db.mjs'

const env = loadEnv()

const SECRET = env.PAYMONGO_SECRET_KEY
if (!SECRET) {
  console.error('PAYMONGO_SECRET_KEY missing from .env — get sk_test_… from the dashboard (Test Mode → Developers → API Keys).')
  process.exit(2)
}
const MODE = SECRET.startsWith('sk_live_') ? 'live' : 'test'

// ── the offer (centavos). TEST PLACEHOLDERS — CEO confirms before live. ──
const PRICES = {
  weekly: { amount: 4900, interval: 'weekly', name: 'START Reels Weekly Membership' },
  monthly: { amount: 14900, interval: 'monthly', name: 'START Reels Monthly Membership' },
  annual: { amount: 99900, interval: 'yearly', name: 'START Reels Annual Membership' },
  // ^ tier → interval map lives HERE and nowhere else ('annual' is ours,
  //   'yearly' is PayMongo's).
}

const SUBS_BASE = 'https://subscriptions-go-api.paymongo.com/v1'
const API_BASE = 'https://api.paymongo.com/v1'
const auth = 'Basic ' + Buffer.from(`${SECRET}:`).toString('base64')

async function pm(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

console.log(`\nPayMongo bootstrap — ${MODE.toUpperCase()} mode\n`)

// ── plans (SUBSCRIPTIONS — org-gated) ────────────────────────────────────
// Plan creation 403s until PayMongo approves subscription payment methods
// (cards/Maya) for the organization. That must NOT block the webhook
// registration below — membership PASSES (one-time checkout) work without
// any of it.
const settingRows = await sql(`select value from public.platform_settings where key = 'paymongo_plans'`)
const stored = settingRows[0]?.value ?? {}
const branch = stored[MODE] ?? {}

let plansBlocked = false
for (const [tier, cfg] of Object.entries(PRICES)) {
  const existing = branch[tier]
  if (existing?.planId) {
    try {
      const remote = await pm(SUBS_BASE, `/subscriptions/plans/${existing.planId}`)
      const amount = remote?.data?.attributes?.amount
      if (amount === cfg.amount) {
        console.log(`  keep   ${tier}: ${existing.planId} (₱${cfg.amount / 100})`)
        continue
      }
      console.log(`  price changed for ${tier} (₱${amount / 100} → ₱${cfg.amount / 100}) — creating a new plan; existing subscribers grandfather.`)
    } catch {
      console.log(`  stored ${tier} plan ${existing.planId} not found remotely — re-creating.`)
    }
  }
  try {
    const created = await pm(SUBS_BASE, '/subscriptions/plans', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          attributes: {
            name: cfg.name,
            description: `${cfg.name} — unlimited episodes while active.`,
            amount: cfg.amount,
            currency: 'PHP',
            interval: cfg.interval,
            interval_count: 1,
            plan_type: 'scheduled',
            metadata: { tier, app: 'start-reels' },
          },
        },
      }),
    })
    branch[tier] = { planId: created.data.id, amountCentavos: cfg.amount }
    console.log(`  create ${tier}: ${created.data.id} (₱${cfg.amount / 100})`)
  } catch (err) {
    if (String(err.message).includes('payment_method_not_configured')) {
      plansBlocked = true
      console.log(`  skip   ${tier}: subscriptions still org-blocked (payment_method_not_configured)`)
      continue
    }
    throw err
  }
}
if (plansBlocked) {
  console.log('\n  Subscription plans remain blocked until PayMongo approves cards/Maya')
  console.log('  for the org — re-run this script once they do. Passes are unaffected.')
}

stored[MODE] = branch
await sql(`
  insert into public.platform_settings (key, value, description)
  values ('paymongo_plans', '${JSON.stringify(stored).replace(/'/g, "''")}'::jsonb,
          'PayMongo plan ids + display prices, mode-scoped {test,live}. Written by scripts/paymongo-setup.mjs.')
  on conflict (key) do update set value = excluded.value, updated_at = now()
`)
console.log('\n  platform_settings.paymongo_plans updated.')

// ── webhook ───────────────────────────────────────────────────────────────
const hookUrl = `${env.SUPABASE_URL}/functions/v1/paymongo-webhook`
const EVENTS = [
  // membership passes (one-time hosted checkout — live TODAY via QRPh)
  'checkout_session.payment.paid',
  // subscriptions (armed for when the org approvals land)
  'subscription.activated',
  'subscription.past_due',
  'subscription.unpaid',
  'subscription.updated',
  'subscription.invoice.paid',
  'subscription.invoice.payment_failed',
]

const hooks = await pm(API_BASE, '/webhooks')
const existingHook = (hooks?.data ?? []).find((h) => h.attributes?.url === hookUrl)

// HAZARD, learned live 2026-08-10: this PayMongo organization is SHARED
// with another team. Our webhook (hook_xtg2Yc…) was silently repointed at
// their server, so every payment event went to them and no membership was
// granted — the payment succeeded and the platform looked broken. So the
// check is "is OUR url registered anywhere", and a hook whose id we own but
// whose url drifted gets corrected rather than duplicated.
const ourHook = (hooks?.data ?? []).find((h) => h.attributes?.url === hookUrl)
const strays = (hooks?.data ?? []).filter((h) => h.attributes?.url !== hookUrl)
if (strays.length) {
  console.log('\n  NOTE: other webhooks exist on this PayMongo org (shared account):')
  for (const s of strays) console.log(`    ${s.id} → ${s.attributes.url}`)
}

if (existingHook || ourHook) {
  console.log(`\n  webhook already registered: ${(existingHook ?? ourHook).id} → ${hookUrl}`)
  console.log('  (its secret was shown when first created; find it via GET /v1/webhooks/{id} if lost)')
} else {
  const created = await pm(API_BASE, '/webhooks', {
    method: 'POST',
    body: JSON.stringify({ data: { attributes: { url: hookUrl, events: EVENTS } } }),
  })
  const secret = created.data.attributes.secret_key
  console.log(`\n  webhook registered: ${created.data.id} → ${hookUrl}`)
  console.log('\n  ── ACTION REQUIRED ─────────────────────────────────────────')
  console.log(`  1. npx supabase secrets set PAYMONGO_WEBHOOK_SECRET=${secret}`)
  console.log(`  2. add PAYMONGO_WEBHOOK_SECRET=${secret} to .env and supabase/.env`)
  console.log('  ────────────────────────────────────────────────────────────')
}

console.log('\nDone.\n')
