#!/usr/bin/env node
/**
 * Entitlement semantics — the rules money depends on, run against the live DB.
 *
 *   - unlock is idempotent: two unlocks inside the window charge ONCE
 *   - two CONCURRENT unlocks charge once (the advisory lock, raced for real)
 *   - free / creator-own / staff paths write NO ledger row at all
 *   - insufficient credits refuses cleanly and leaves no partial state
 *   - unpublished + suspended are refused
 *   - price changes do not rewrite history (credits_charged is a snapshot)
 *   - revoking a video reverses pending holds and refunds committed spends
 *
 * Usage:  node scripts/test-entitlements.mjs
 */

import { loadEnv, makeHarness, sql, sqlExpectError } from './_db.mjs'

loadEnv()
const h = makeHarness()

const U = {
  buyer: 'ent_test_buyer',
  poor: 'ent_test_poor',
  creator: 'ent_test_creator',
  mod: 'ent_test_mod',
  suspended: 'ent_test_suspended',
}

async function cleanup() {
  const ids = Object.values(U).map((u) => `'${u}'`).join(',')
  await sql(`
    delete from public.watch_sessions where user_id in (${ids});
    delete from public.watch_history where user_id in (${ids});
    delete from public.video_entitlements where user_id in (${ids});
    delete from public.credit_ledger where user_id in (${ids});
    delete from public.videos where slug like 'ent-test-%';
    delete from public.user_roles where user_id in (${ids});
    delete from public.profiles where user_id in (${ids});
  `)
}

console.log('\nEntitlement semantics - live database\n')

try {
  await cleanup()

  // ── seed ──────────────────────────────────────────────────────────────
  await sql(`
    insert into public.profiles (user_id, email) values
      ('${U.buyer}', 'ent-buyer@test.local'),
      ('${U.poor}', 'ent-poor@test.local'),
      ('${U.creator}', 'ent-creator@test.local'),
      ('${U.mod}', 'ent-mod@test.local'),
      ('${U.suspended}', 'ent-suspended@test.local');
    update public.profiles set suspended_at = now() where user_id = '${U.suspended}';
    insert into public.user_roles (user_id, role) values ('${U.mod}', 'moderator');

    select public.grant_credits('${U.buyer}', 20, 'admin_grant', null, null, 'watch', 'ent-test-buyer-seed', '{}'::jsonb);
    select public.grant_credits('${U.suspended}', 20, 'admin_grant', null, null, 'watch', 'ent-test-susp-seed', '{}'::jsonb);

    insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, duration_seconds, published_at) values
      ('Ent Free',      'ent-test-free',      '${U.creator}', 'published', 'free',      0, 300, now()),
      ('Ent Premium',   'ent-test-premium',   '${U.creator}', 'published', 'premium',   1, 300, now()),
      ('Ent Exclusive', 'ent-test-exclusive', '${U.creator}', 'published', 'exclusive', 3, 300, now()),
      ('Ent Draft',     'ent-test-draft',     '${U.creator}', 'draft',     'premium',   1, 300, null);
  `)

  const vids = Object.fromEntries(
    (await sql(`select slug, id from public.videos where slug like 'ent-test-%'`)).map((v) => [v.slug, v.id]),
  )

  const bal = async (u) => Number((await sql(`select public.available_credits('${u}', 'watch') as b`))[0].b)

  // ── idempotency ───────────────────────────────────────────────────────
  h.section('Unlock idempotency')
  {
    const first = (await sql(`select public.unlock_video('${U.buyer}', '${vids['ent-test-premium']}') as r`))[0].r
    h.check('first unlock charges 1', first.charged === 1 && first.already_unlocked === false, JSON.stringify(first))
    h.check('balance is 19 (20 - 1 hold)', (await bal(U.buyer)) === 19)

    const second = (await sql(`select public.unlock_video('${U.buyer}', '${vids['ent-test-premium']}') as r`))[0].r
    h.check('second unlock returns the SAME entitlement', second.entitlement_id === first.entitlement_id, JSON.stringify(second))
    h.check('second unlock charges 0', second.charged === 0 && second.already_unlocked === true)
    h.check('balance still 19 - no double charge', (await bal(U.buyer)) === 19)

    const holds = await sql(`
      select count(*)::int as n from public.credit_ledger
      where user_id = '${U.buyer}' and status = 'pending'
    `)
    h.check('exactly one hold exists', holds[0].n === 1, `${holds[0].n} holds`)
  }

  // ── the race the advisory lock exists for ─────────────────────────────
  h.section('Concurrent unlock (two tabs hit Play at once)')
  {
    const target = vids['ent-test-exclusive']
    // Two genuinely parallel requests. Without pg_advisory_xact_lock both
    // would pass the existence check before either inserted, and the user
    // would pay 6 credits for one video.
    const [a, b] = await Promise.all([
      sql(`select public.unlock_video('${U.buyer}', '${target}') as r`),
      sql(`select public.unlock_video('${U.buyer}', '${target}') as r`),
    ])
    const ra = a[0].r
    const rb = b[0].r
    h.check('both calls returned the same entitlement', ra.entitlement_id === rb.entitlement_id,
      `${ra.entitlement_id} vs ${rb.entitlement_id}`)
    h.check('exactly one was charged', (ra.charged === 3) !== (rb.charged === 3) || (ra.charged === 3 && rb.charged === 0) || (ra.charged === 0 && rb.charged === 3),
      `charged: ${ra.charged} and ${rb.charged}`)
    h.check('balance is 16 (19 - 3), not 13', (await bal(U.buyer)) === 16, `got ${await bal(U.buyer)}`)

    const holds = await sql(`
      select count(*)::int as n from public.credit_ledger
      where user_id = '${U.buyer}' and status = 'pending' and reference_id = '${target}'
    `)
    h.check('exactly one hold for that video', holds[0].n === 1, `${holds[0].n}`)
  }

  // ── free paths write no ledger rows ───────────────────────────────────
  h.section('Free paths write NO ledger row')
  {
    const free = (await sql(`select public.unlock_video('${U.buyer}', '${vids['ent-test-free']}') as r`))[0].r
    h.check('free video: charged 0, no ledger id', free.charged === 0 && free.ledger_id === null, JSON.stringify(free))

    const own = (await sql(`select public.unlock_video('${U.creator}', '${vids['ent-test-premium']}') as r`))[0].r
    h.check('creator watching own premium video: free', own.charged === 0 && own.ledger_id === null, JSON.stringify(own))

    const mod = (await sql(`select public.unlock_video('${U.mod}', '${vids['ent-test-exclusive']}') as r`))[0].r
    h.check('moderator: role bypass, free', mod.charged === 0 && mod.ledger_id === null, JSON.stringify(mod))

    const rows = await sql(`
      select count(*)::int as n from public.credit_ledger
      where user_id in ('${U.creator}', '${U.mod}')
    `)
    h.check('creator and moderator have ZERO ledger rows', rows[0].n === 0, `${rows[0].n} rows`)

    // Compare as a map, not an ordered array — `order by source` on an enum
    // sorts by declaration position, not alphabetically.
    const sources = await sql(`
      select source, count(*)::int as n from public.video_entitlements
      where user_id in ('${U.buyer}','${U.creator}','${U.mod}')
      group by source
    `)
    const byName = Object.fromEntries(sources.map((s) => [s.source, s.n]))
    h.check(
      'entitlement sources recorded correctly',
      byName.purchase === 2 && byName.free_tier === 1 &&
        byName.creator_own === 1 && byName.role_bypass === 1 &&
        sources.length === 4,
      JSON.stringify(byName),
    )
  }

  // ── refusals ──────────────────────────────────────────────────────────
  h.section('Refusals')
  {
    const err = await sqlExpectError(`select public.unlock_video('${U.poor}', '${vids['ent-test-premium']}')`)
    h.check('no credits -> insufficient_credits', err?.includes('insufficient_credits'), err)

    const state = await sql(`
      select
        (select count(*)::int from public.video_entitlements where user_id = '${U.poor}') as ents,
        (select count(*)::int from public.credit_ledger where user_id = '${U.poor}') as ledger
    `)
    h.check('refused unlock left no partial state', state[0].ents === 0 && state[0].ledger === 0, JSON.stringify(state[0]))

    const draft = await sqlExpectError(`select public.unlock_video('${U.buyer}', '${vids['ent-test-draft']}')`)
    h.check('draft video refused for non-creator', draft?.includes('video_not_published'), draft)

    const ownDraft = (await sql(`select public.unlock_video('${U.creator}', '${vids['ent-test-draft']}') as r`))[0].r
    h.check('...but the creator can open their own draft', ownDraft.charged === 0, JSON.stringify(ownDraft))

    const susp = await sqlExpectError(`select public.unlock_video('${U.suspended}', '${vids['ent-test-premium']}')`)
    h.check('suspended account refused even with credits', susp?.includes('account_suspended'), susp)
  }

  // ── price snapshot ────────────────────────────────────────────────────
  h.section('Price changes do not rewrite history')
  {
    await sql(`update public.videos set credit_cost = 5 where id = '${vids['ent-test-exclusive']}'`)
    const snap = await sql(`
      select credits_charged from public.video_entitlements
      where user_id = '${U.buyer}' and video_id = '${vids['ent-test-exclusive']}'
    `)
    h.check('entitlement still shows the 3 that was paid, not the new 5', Number(snap[0].credits_charged) === 3,
      `snapshot is ${snap[0].credits_charged}`)
    await sql(`update public.videos set credit_cost = 3 where id = '${vids['ent-test-exclusive']}'`)
  }

  // ── revocation ────────────────────────────────────────────────────────
  h.section('Revoking a video (delete-with-refund)')
  {
    // buyer's exclusive hold is still pending -> reversal (never truly spent).
    // Commit the premium hold first to prove the OTHER path: refund row.
    const premiumHold = await sql(`
      select ledger_id from public.video_entitlements
      where user_id = '${U.buyer}' and video_id = '${vids['ent-test-premium']}'
    `)
    await sql(`select public.settle_credit_hold('${premiumHold[0].ledger_id}', true)`)
    h.check('premium hold committed (simulating a watched video)', (await bal(U.buyer)) === 16)

    const r1 = await sql(`select public.revoke_video_entitlements('${vids['ent-test-premium']}', 'test_takedown') as n`)
    h.check('premium revocation touched entitlements', r1[0].n >= 1, `${r1[0].n}`)
    h.check('committed spend was REFUNDED (16 -> 17)', (await bal(U.buyer)) === 17, `got ${await bal(U.buyer)}`)

    const refund = await sql(`
      select count(*)::int as n from public.credit_ledger
      where user_id = '${U.buyer}' and reason = 'refund' and status = 'committed'
    `)
    h.check('an explicit refund row exists', refund[0].n === 1, `${refund[0].n}`)

    const r2 = await sql(`select public.revoke_video_entitlements('${vids['ent-test-exclusive']}', 'test_takedown') as n`)
    h.check('exclusive revocation ran', r2[0].n >= 1, `${r2[0].n}`)
    h.check('pending hold was REVERSED, not refunded (17 -> 20)', (await bal(U.buyer)) === 20, `got ${await bal(U.buyer)}`)

    const reversed = await sql(`
      select count(*)::int as n from public.credit_ledger
      where user_id = '${U.buyer}' and status = 'reversed'
    `)
    h.check('the exclusive hold shows as reversed', reversed[0].n === 1, `${reversed[0].n}`)

    const live = await sql(`
      select count(*)::int as n from public.video_entitlements
      where user_id = '${U.buyer}' and revoked_at is null and expires_at > now()
        and video_id in ('${vids['ent-test-premium']}', '${vids['ent-test-exclusive']}')
    `)
    h.check('both entitlements are revoked', live[0].n === 0, `${live[0].n} still live`)
  }
} finally {
  console.log('\nCleaning up...')
  await cleanup()
}

h.finish('ENTITLEMENTS')
