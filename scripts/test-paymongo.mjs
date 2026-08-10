#!/usr/bin/env node
/**
 * The PayMongo payment rail (0029), in two sections:
 *
 *   §1 SQL — apply_subscription_payment on the live DB. Needs no PayMongo
 *      account at all: the money→membership math, the invoice-id dedupe,
 *      tier day-counts, admin-comp stacking, and the one-live-subscription
 *      index are pure database facts.
 *
 *   §2 HTTP — the DEPLOYED paymongo-webhook, driven by synthetically
 *      signed events (the test-webhook.mjs precedent: we hold the same
 *      secret PayMongo holds, so we can BE PayMongo). Signature negatives,
 *      claim-layer replays, and the two-layer invoice dedupe. SKIPPED with
 *      a loud note until PAYMONGO_WEBHOOK_SECRET exists in .env (it is
 *      born when paymongo-setup.mjs registers the webhook).
 *
 * Usage:  node scripts/test-paymongo.mjs
 */

import { createHmac } from 'node:crypto'

import { loadEnv, makeHarness, sql, sqlExpectError } from './_db.mjs'

const env = loadEnv()
const h = makeHarness()

const RUN = Date.now()
const USER = 'paymongo_tester'
const SUB = `sub_test_${RUN}`

const expiry = async () =>
  (await sql(`select expires_at from public.memberships where user_id = '${USER}'`))[0]?.expires_at ?? null

const apply = (tier, invoiceId, subId = SUB) =>
  sql(`
    select public.apply_subscription_payment(
      '${USER}', '${tier}', '${subId}', '${invoiceId}', 14900, now()
    ) as r
  `).then((r) => r[0].r)

console.log('\nPayMongo rail (0029) — SQL + deployed webhook\n')

async function cleanup() {
  await sql(`
    delete from public.payment_invoices where user_id = '${USER}';
    delete from public.payment_subscriptions where user_id = '${USER}';
    delete from public.payment_customers where user_id = '${USER}';
    delete from public.memberships where user_id = '${USER}';
    delete from public.profiles where user_id = '${USER}';
    delete from public.processed_webhook_events where event_id like 'evt_pmtest_${RUN}%';
  `).catch(() => {})
}

try {
  await cleanup()
  await sql(`
    insert into public.profiles (user_id, email) values ('${USER}', 'paymongo-tester@test.local');
    insert into public.payment_subscriptions (user_id, tier, status, provider_subscription_id)
    values ('${USER}', 'monthly', 'incomplete', '${SUB}');
  `)

  h.section('§1 apply_subscription_payment — money → membership math')
  {
    const first = await apply('monthly', `inv_${RUN}_1`)
    h.check('a fresh payment grants ~30 days', first.applied === true && first.days_granted === 30,
      JSON.stringify(first))
    const afterFirst = await expiry()
    const days = (Date.parse(afterFirst) - Date.now()) / 86_400_000
    h.check('expiry lands 29–31 days out', days > 29 && days < 31, `${days.toFixed(2)} days`)

    const dup = await apply('monthly', `inv_${RUN}_1`)
    h.check('the SAME invoice id is a duplicate no-op', dup.applied === false && dup.duplicate === true,
      JSON.stringify(dup))
    h.check('…and expiry is byte-identical', (await expiry()) === afterFirst)

    const second = await apply('monthly', `inv_${RUN}_2`)
    h.check('a renewal invoice stacks onto the CURRENT expiry', second.applied === true,
      JSON.stringify(second))
    const days2 = (Date.parse(await expiry()) - Date.now()) / 86_400_000
    h.check('two paid months ≈ 60 days out', days2 > 59 && days2 < 61, `${days2.toFixed(2)} days`)

    const weekly = await apply('weekly', `inv_${RUN}_3`)
    h.check('weekly grants 7 days (widened tier check holds)',
      weekly.applied === true && weekly.days_granted === 7, JSON.stringify(weekly))

    const badTier = await sqlExpectError(`
      select public.apply_subscription_payment('${USER}', 'lifetime', '${SUB}', 'inv_${RUN}_bad', 0, now())
    `)
    h.check('a garbage tier is refused', badTier?.includes('bad_request'), badTier ?? 'NO ERROR')

    const status = await sql(`
      select status, current_period_end from public.payment_subscriptions
      where provider_subscription_id = '${SUB}'
    `)
    h.check('a paid invoice flips the subscription row to active',
      status[0]?.status === 'active' && status[0]?.current_period_end !== null,
      JSON.stringify(status[0]))
  }

  h.section('§1 admin comp + payment stack on the same row')
  {
    const before = await expiry()
    // The admin door (0028 semantics): extend from max(now, expiry).
    await sql(`
      update public.memberships
      set expires_at = greatest(expires_at, now()) + interval '30 days'
      where user_id = '${USER}'
    `)
    const comped = await expiry()
    h.check('an admin comp stacks on top of paid time', Date.parse(comped) > Date.parse(before))

    await apply('monthly', `inv_${RUN}_4`)
    const paid = await expiry()
    h.check('…and the next payment stacks on top of the comp',
      Math.round((Date.parse(paid) - Date.parse(comped)) / 86_400_000) === 30,
      `delta ${(Date.parse(paid) - Date.parse(comped)) / 86_400_000} days`)
  }

  h.section('§1 one live subscription per user (partial unique index)')
  {
    const second = await sqlExpectError(`
      insert into public.payment_subscriptions (user_id, tier, status)
      values ('${USER}', 'annual', 'pending')
    `)
    h.check('a second live subscription row is refused', second !== null, second ?? 'INSERT SUCCEEDED')

    await sql(`
      update public.payment_subscriptions set status = 'cancelled', cancelled_at = now()
      where provider_subscription_id = '${SUB}';
      insert into public.payment_subscriptions (user_id, tier, status)
      values ('${USER}', 'annual', 'pending');
    `)
    const rows = await sql(`select count(*)::int as n from public.payment_subscriptions where user_id = '${USER}'`)
    h.check('…but a cancelled row does not block a new one', rows[0].n === 2, `${rows[0].n} rows`)
  }

  // ── §2: the deployed webhook ─────────────────────────────────────────────
  const WHSECRET = env.PAYMONGO_WEBHOOK_SECRET
  if (!WHSECRET) {
    console.log('\n§2 webhook HTTP: SKIPPED — PAYMONGO_WEBHOOK_SECRET not in .env yet.')
    console.log('   Run scripts/paymongo-setup.mjs once the PayMongo test keys exist;')
    console.log('   it registers the webhook and prints the secret to store.\n')
  } else {
    const HOOK = `${env.SUPABASE_URL}/functions/v1/paymongo-webhook`

    // Re-arm a live sub row for the webhook tests.
    const SUB2 = `sub_test_${RUN}_wh`
    await sql(`
      delete from public.payment_subscriptions where user_id = '${USER}' and status = 'pending';
      insert into public.payment_subscriptions (user_id, tier, status, provider_subscription_id)
      values ('${USER}', 'monthly', 'incomplete', '${SUB2}')
      on conflict do nothing;
    `)

    const makeEvent = (eventId, type, resource) =>
      JSON.stringify({ data: { id: eventId, attributes: { type, livemode: false, data: resource } } })

    const sign = (body, { mode = 'te', secret = WHSECRET, t = Math.floor(Date.now() / 1000) } = {}) => {
      const mac = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
      const other = mode === 'te' ? 'li' : 'te'
      return `t=${t},${mode}=${mac},${other}=deadbeef`
    }

    const post = (body, signature) =>
      fetch(HOOK, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(signature ? { 'Paymongo-Signature': signature } : {}),
        },
        body,
      }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))

    h.section('§2 webhook: signature discipline')
    {
      const body = makeEvent(`evt_pmtest_${RUN}_sig`, 'subscription.updated', { id: SUB2, attributes: { status: 'active' } })
      const missing = await post(body, null)
      h.check('missing signature header → 400', missing.status === 400, `HTTP ${missing.status}`)
      const forged = await post(body, sign(body, { secret: 'whsk_wrong' }))
      h.check('forged signature → 401', forged.status === 401, `HTTP ${forged.status}`)
      const wrongMode = await post(body, sign(body, { mode: 'li' }))
      h.check('live-mode signature on a test-mode server → 401', wrongMode.status === 401, `HTTP ${wrongMode.status}`)
    }

    h.section('§2 webhook: paid invoice extends, replays never double')
    {
      const before = await expiry()
      const invoice = {
        id: `inv_${RUN}_wh1`,
        attributes: { subscription_id: SUB2, amount: 14900, status: 'paid' },
      }
      const body = makeEvent(`evt_pmtest_${RUN}_paid`, 'subscription.invoice.paid', invoice)
      const ok = await post(body, sign(body))
      h.check('a signed invoice.paid is 200', ok.status === 200, `HTTP ${ok.status}: ${JSON.stringify(ok.data)}`)
      const after = await expiry()
      h.check('…and membership extended ~30 days',
        Math.round((Date.parse(after) - Date.parse(before)) / 86_400_000) === 30,
        `delta ${(Date.parse(after) - Date.parse(before)) / 86_400_000}`)

      const replay = await post(body, sign(body))
      h.check('the SAME event replayed → 200 {replay}', replay.status === 200 && replay.data?.replay === true,
        JSON.stringify(replay.data))
      h.check('…expiry unchanged (claim layer)', (await expiry()) === after)

      // Same INVOICE under a DIFFERENT event id — the two-layer test.
      const body2 = makeEvent(`evt_pmtest_${RUN}_paid2`, 'subscription.invoice.paid', invoice)
      const secondDelivery = await post(body2, sign(body2))
      h.check('the same invoice under a NEW event id → 200', secondDelivery.status === 200,
        `HTTP ${secondDelivery.status}`)
      h.check('…expiry STILL unchanged (invoice layer)', (await expiry()) === after)
    }

    h.section('§2 webhook: status events never touch paid time')
    {
      const before = await expiry()
      for (const type of ['subscription.past_due', 'subscription.unpaid']) {
        const body = makeEvent(`evt_pmtest_${RUN}_${type}`, type, { id: SUB2, attributes: { status: type.split('.')[1] } })
        const res = await post(body, sign(body))
        h.check(`${type} → 200`, res.status === 200, `HTTP ${res.status}`)
      }
      const st = await sql(`select status from public.payment_subscriptions where provider_subscription_id = '${SUB2}'`)
      h.check('subscription row reflects unpaid', st[0]?.status === 'unpaid', st[0]?.status)
      h.check('memberships.expires_at untouched (no clawback, structurally)', (await expiry()) === before)

      const body = makeEvent(`evt_pmtest_${RUN}_ghost`, 'subscription.invoice.paid', {
        id: `inv_${RUN}_ghost`, attributes: { subscription_id: 'sub_nobody', amount: 100 },
      })
      const ghost = await post(body, sign(body))
      h.check('an unknown subscription → 200, no crash', ghost.status === 200, `HTTP ${ghost.status}`)
    }

    h.section('§3 the webhook actually points at US (shared-org hazard)')
    {
      const auth = 'Basic ' + Buffer.from(`${env.PAYMONGO_SECRET_KEY}:`).toString('base64')
      const res = await fetch('https://api.paymongo.com/v1/webhooks', { headers: { Authorization: auth } })
      const body = await res.json().catch(() => null)
      const ours = (body?.data ?? []).find((w) => w.attributes?.url === HOOK)
      // 2026-08-10: another team on this PayMongo org repointed our webhook
      // at their server. Payments succeeded, memberships never granted, and
      // nothing in our logs said why. This assertion is that day's scar.
      h.check('a webhook is registered to OUR endpoint', Boolean(ours),
        `registered: ${(body?.data ?? []).map((w) => w.attributes?.url).join(', ') || 'none'}`)
      h.check('…and it is enabled', ours?.attributes?.status === 'enabled', ours?.attributes?.status)
      h.check('…and subscribes to checkout_session.payment.paid',
        (ours?.attributes?.events ?? []).includes('checkout_session.payment.paid'),
        JSON.stringify(ours?.attributes?.events))
    }

    h.section('§4 membership passes: checkout_session.payment.paid (0030)')
    {
      const before = await expiry()
      const session = {
        id: `cs_test_${RUN}`,
        attributes: {
          metadata: { user_id: USER, tier: 'weekly', app: 'start-reels', kind: 'membership_pass' },
          payments: [{ id: `pay_${RUN}`, attributes: { amount: 4900, status: 'paid' } }],
        },
      }
      const body = makeEvent(`evt_pmtest_${RUN}_pass`, 'checkout_session.payment.paid', session)
      const ok = await post(body, sign(body))
      h.check('a signed pass payment is 200', ok.status === 200, `HTTP ${ok.status}: ${JSON.stringify(ok.data)}`)
      const after = await expiry()
      h.check('…and extends the membership by 7 days (weekly pass)',
        Math.round((Date.parse(after) - Date.parse(before)) / 86_400_000) === 7,
        `delta ${(Date.parse(after) - Date.parse(before)) / 86_400_000}`)

      const invoice = await sql(`
        select amount_centavos, tier from public.payment_invoices
        where provider_invoice_id = 'cs_test_${RUN}'
      `)
      h.check('the session lands in payment_invoices (revenue record)',
        invoice[0]?.amount_centavos === 4900 && invoice[0]?.tier === 'weekly', JSON.stringify(invoice[0]))

      const replay = await post(body, sign(body))
      h.check('an exact replay → 200 {replay}', replay.status === 200 && replay.data?.replay === true,
        JSON.stringify(replay.data))
      h.check('…expiry unchanged (claim layer)', (await expiry()) === after)

      const body2 = makeEvent(`evt_pmtest_${RUN}_pass2`, 'checkout_session.payment.paid', session)
      const redelivery = await post(body2, sign(body2))
      h.check('the same SESSION under a new event id → 200', redelivery.status === 200, `HTTP ${redelivery.status}`)
      h.check('…expiry STILL unchanged (session-id invoice layer)', (await expiry()) === after)

      const orphan = {
        id: `cs_orphan_${RUN}`,
        attributes: { metadata: {}, payments: [] },
      }
      const body3 = makeEvent(`evt_pmtest_${RUN}_orphan`, 'checkout_session.payment.paid', orphan)
      const skipped = await post(body3, sign(body3))
      h.check('a session without our metadata → 200, no grant', skipped.status === 200, `HTTP ${skipped.status}`)
      h.check('…and expiry untouched by the orphan', (await expiry()) === after)
    }
  }
} finally {
  console.log('\nCleaning up...')
  await cleanup()
}

h.finish('PAYMONGO')
