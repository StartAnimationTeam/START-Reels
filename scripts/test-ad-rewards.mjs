#!/usr/bin/env node
/**
 * The rewarded-ad coin rail (0027), end to end:
 *
 *   SQL (grant_ad_reward, as the service role would call it):
 *     - a grant mints coins and writes the event + ledger pair
 *     - a replayed transaction_id returns the ORIGINAL grant — one ledger row
 *     - the daily cap refuses grant N+1 … and resets at Manila midnight
 *     - the min-interval guard refuses rapid-fire grants
 *     - the master switch refuses everything
 *
 *   HTTP (ads-ssv, the deployed function):
 *     - the unsigned real path is 403 (no free coins for the curious)
 *     - the test rail requires BOTH the secret header and ad_test_mode
 *     - Google's signed-callback crypto verifies for real: we mint our own
 *       P-256 keypair, host the public key via SSV_KEYS_URL (a data: URL),
 *       sign the query Google-style (ECDSA-SHA256, DER, websafe-base64) and
 *       prove grant → replay-no-double through the production code path
 *
 * The suite ends with ad_test_mode = FALSE — the safe steady state.
 *
 * Usage:  node scripts/test-ad-rewards.mjs
 */

import { createSign, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadEnv, makeHarness, sql, sqlExpectError } from './_db.mjs'

const env = loadEnv()
const h = makeHarness()
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ADS_TEST_SECRET lives with the Edge Function secrets, not the root env.
const supaEnv = Object.fromEntries(
  readFileSync(join(ROOT, 'supabase', '.env'), 'utf8')
    .split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
)
const TEST_SECRET = supaEnv.ADS_TEST_SECRET
if (!TEST_SECRET) {
  console.error('ADS_TEST_SECRET missing from supabase/.env — cannot run the HTTP rail tests.')
  process.exit(1)
}

const SSV_URL = `${env.SUPABASE_URL}/functions/v1/ads-ssv`
const USER = 'ad_rewards_tester'
const RUN = `${Date.now()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const bal = async () =>
  Number((await sql(`select public.available_credits('${USER}', 'watch') as b`))[0].b)

const grant = (tx, provider = 'test') =>
  sql(`select public.grant_ad_reward('${USER}', '${provider}', '${tx}') as r`).then((r) => r[0].r)

const grantErr = (tx, provider = 'test') =>
  sqlExpectError(`select public.grant_ad_reward('${USER}', '${provider}', '${tx}')`)

const setSetting = (key, valueJson) =>
  sql(`update public.platform_settings set value = '${valueJson}'::jsonb where key = '${key}'`)

/** Supabase Management API — used ONLY for the temporary SSV_KEYS_URL secret. */
const mgmtSecrets = (method, body) =>
  fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/secrets`, {
    method,
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

console.log('\nRewarded-ad rail (0027) — SQL + deployed ads-ssv\n')

// Save the live knobs so the suite leaves the platform exactly as found
// (except ad_test_mode, which deliberately ends false).
const saved = Object.fromEntries(
  (
    await sql(`
      select key, value from public.platform_settings
      where key in ('ad_rewards_enabled', 'ad_reward_amount', 'ad_reward_daily_cap',
                    'ad_reward_min_interval_seconds', 'ad_test_mode')
    `)
  ).map((r) => [r.key, JSON.stringify(r.value)]),
)

let ssvKeyInstalled = false

async function cleanup() {
  for (const [k, v] of Object.entries(saved)) {
    if (k === 'ad_test_mode') continue // deliberate: ends false, below
    await setSetting(k, v).catch(() => {})
  }
  await setSetting('ad_test_mode', 'false').catch(() => {})
  await sql(`
    delete from public.ad_reward_events where user_id = '${USER}';
    delete from public.credit_ledger where user_id = '${USER}';
    delete from public.profiles where user_id = '${USER}';
  `).catch(() => {})
  if (ssvKeyInstalled) {
    await mgmtSecrets('DELETE', ['SSV_KEYS_URL']).catch(() => {})
  }
}

try {
  await sql(`
    delete from public.ad_reward_events where user_id = '${USER}';
    delete from public.credit_ledger where user_id = '${USER}';
    insert into public.profiles (user_id, email) values ('${USER}', 'ad-rewards-tester@test.local')
    on conflict (user_id) do nothing;
  `)
  await setSetting('ad_rewards_enabled', 'true')
  await setSetting('ad_reward_amount', '5')
  await setSetting('ad_reward_min_interval_seconds', '0')
  await setSetting('ad_reward_daily_cap', '10')

  h.section('Grant + replay (SQL rail)')
  {
    const before = await bal()
    const first = await grant(`sqltest-${RUN}-1`)
    h.check('a fresh transaction grants', first.status === 'granted' && Number(first.amount) === 5,
      JSON.stringify(first))
    h.check('balance +5', (await bal()) === before + 5)
    h.check('the grant reports today 1 of cap 10',
      first.today_count === 1 && first.daily_cap === 10, JSON.stringify(first))

    const replay = await grant(`sqltest-${RUN}-1`)
    h.check('a replayed transaction returns duplicate with the SAME ledger_id',
      replay.status === 'duplicate' && replay.ledger_id === first.ledger_id,
      JSON.stringify({ first, replay }))
    h.check('balance unchanged by the replay', (await bal()) === before + 5)

    const rows = await sql(`
      select count(*)::int as n from public.credit_ledger
      where user_id = '${USER}' and reference_type = 'ad_reward'
    `)
    h.check('exactly one ad_reward ledger row exists', rows[0].n === 1, `${rows[0].n} rows`)

    // Same transaction_id under a DIFFERENT provider is a different event —
    // the unique key is (provider, transaction_id), matching Google's scoping.
    const cross = await grant(`sqltest-${RUN}-1`, 'gpt_web')
    h.check('the same tx id under another provider is its own grant',
      cross.status === 'granted', JSON.stringify(cross))
  }

  h.section('Daily cap, on the Manila calendar')
  {
    await setSetting('ad_reward_daily_cap', '2') // exactly 2 grants exist already
    const refused = await grantErr(`sqltest-${RUN}-capped`)
    h.check('grant N+1 is refused with ad_reward_cap_reached',
      refused?.includes('ad_reward_cap_reached'), refused ?? 'NO ERROR')

    // Midnight cannot be waited for; it can be manufactured — backdate every
    // event one day and the platform-tz window opens again.
    await sql(`
      update public.ad_reward_events
      set created_at = created_at - interval '1 day'
      where user_id = '${USER}'
    `)
    const fresh = await grant(`sqltest-${RUN}-newday`)
    h.check('the cap resets at platform midnight (backdated events free the window)',
      fresh.status === 'granted' && fresh.today_count === 1, JSON.stringify(fresh))
    await setSetting('ad_reward_daily_cap', '10')
  }

  h.section('Min-interval guard')
  {
    await setSetting('ad_reward_min_interval_seconds', '3600')
    const refused = await grantErr(`sqltest-${RUN}-rapid`)
    h.check('a grant inside the interval is refused with ad_reward_too_soon',
      refused?.includes('ad_reward_too_soon'), refused ?? 'NO ERROR')
    await setSetting('ad_reward_min_interval_seconds', '0')
  }

  h.section('Master switch')
  {
    await setSetting('ad_rewards_enabled', 'false')
    const refused = await grantErr(`sqltest-${RUN}-off`)
    h.check('disabled refuses with ad_rewards_disabled',
      refused?.includes('ad_rewards_disabled'), refused ?? 'NO ERROR')

    // A replay of an EXISTING grant still answers while disabled — duplicate
    // check runs before the cap but after the switch? No: the switch is
    // first. Google replaying an old callback while ads are paused must not
    // 500-loop; the ssv function converts the raise into a 200 skip. Assert
    // the raise is the named error so that mapping holds.
    const replayOff = await grantErr(`sqltest-${RUN}-1`)
    h.check('…including for replays (ads-ssv maps this to a 200 skip)',
      replayOff?.includes('ad_rewards_disabled'), replayOff ?? 'NO ERROR')
    await setSetting('ad_rewards_enabled', 'true')
  }

  h.section('ads-ssv: unsigned + test rail (deployed function)')
  {
    const unsigned = await fetch(`${SSV_URL}?user_id=${USER}&transaction_id=nope-${RUN}`)
    h.check('the unsigned real path is 403', unsigned.status === 403, `HTTP ${unsigned.status}`)

    const badSecret = await fetch(`${SSV_URL}?user_id=${USER}&transaction_id=nope-${RUN}`, {
      headers: { 'x-ads-test-secret': 'wrong' },
    })
    h.check('a wrong test secret is 401', badSecret.status === 401, `HTTP ${badSecret.status}`)

    await setSetting('ad_test_mode', 'false')
    const modeOff = await fetch(`${SSV_URL}?user_id=${USER}&transaction_id=nope-${RUN}`, {
      headers: { 'x-ads-test-secret': TEST_SECRET },
    })
    h.check('the right secret with ad_test_mode OFF is 403 (both gates required)',
      modeOff.status === 403, `HTTP ${modeOff.status}`)

    await setSetting('ad_test_mode', 'true')
    const before = await bal()
    const tx = `httptest-${RUN}`
    const good = await fetch(`${SSV_URL}?user_id=${USER}&transaction_id=${tx}`, {
      headers: { 'x-ads-test-secret': TEST_SECRET },
    })
    const goodData = await good.json().catch(() => null)
    h.check('the armed test rail grants', good.status === 200 && goodData?.status === 'granted',
      `HTTP ${good.status}: ${JSON.stringify(goodData)}`)
    h.check('…and the coins are real', (await bal()) === before + 5)

    const replay = await fetch(`${SSV_URL}?user_id=${USER}&transaction_id=${tx}`, {
      headers: { 'x-ads-test-secret': TEST_SECRET },
    })
    const replayData = await replay.json().catch(() => null)
    h.check('an HTTP replay is 200 duplicate, not a double',
      replay.status === 200 && replayData?.status === 'duplicate' &&
        replayData?.ledger_id === goodData?.ledger_id,
      `HTTP ${replay.status}: ${JSON.stringify(replayData)}`)
    h.check('balance unchanged by the HTTP replay', (await bal()) === before + 5)
  }

  h.section("ads-ssv: Google's signed callback, cryptographically for real")
  {
    // Stand in for Google: our own P-256 keypair, public half served to the
    // function through SSV_KEYS_URL (Deno fetch accepts data: URLs), queries
    // signed exactly as AdMob signs them.
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const KEY_ID = 424242
    const keysJson = JSON.stringify({ keys: [{ keyId: KEY_ID, base64: spki }] })
    const keysUrl = `data:application/json;base64,${Buffer.from(keysJson).toString('base64')}`

    const signedUrl = (tx) => {
      const content = `ad_network=5450213213286189855&ad_unit=1234567890&reward_amount=5&reward_item=coins&timestamp=${Date.now()}&transaction_id=${tx}&user_id=${USER}`
      const der = createSign('SHA256').update(content, 'utf8').sign(privateKey)
      const sig = der.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      return `${SSV_URL}?${content}&signature=${sig}&key_id=${KEY_ID}`
    }

    const put = await mgmtSecrets('POST', [{ name: 'SSV_KEYS_URL', value: keysUrl }])
    h.check('SSV_KEYS_URL override installed (temporary)', put.ok, `HTTP ${put.status}`)
    ssvKeyInstalled = true

    // Secrets propagate on function restart — poll until the signed call
    // lands (fresh tx each attempt would defeat the replay test; the URL is
    // deterministic per tx and duplicates are fine to re-request).
    const tx = `ssvtest-${RUN}`
    const before = await bal()
    let verified = null
    for (let attempt = 0; attempt < 18 && !verified; attempt++) {
      if (attempt > 0) await sleep(5000)
      const res = await fetch(signedUrl(tx))
      if (res.status === 200) verified = await res.json().catch(() => null)
    }
    h.check('a correctly signed callback verifies and grants',
      verified?.ok === true && verified?.status === 'granted', JSON.stringify(verified))
    h.check('…as provider admob',
      (await sql(`select provider from public.ad_reward_events where transaction_id = '${tx}'`))[0]
        ?.provider === 'admob')
    h.check('…and mints the coins', (await bal()) === before + 5)

    const replayRes = await fetch(signedUrl(tx))
    const replayData = await replayRes.json().catch(() => null)
    h.check('a replayed signed callback is 200 duplicate (Google must not retry-storm)',
      replayRes.status === 200 && replayData?.status === 'duplicate', JSON.stringify(replayData))
    h.check('…and does not double', (await bal()) === before + 5)

    // Tampering: same query, signature from a different keypair.
    const { privateKey: rogue } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const content = `reward_amount=999&transaction_id=forged-${RUN}&user_id=${USER}`
    const forgedSig = createSign('SHA256').update(content, 'utf8').sign(rogue)
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const forged = await fetch(`${SSV_URL}?${content}&signature=${forgedSig}&key_id=${KEY_ID}`)
    h.check('a signature from the wrong key is 403', forged.status === 403, `HTTP ${forged.status}`)

    const del = await mgmtSecrets('DELETE', ['SSV_KEYS_URL'])
    h.check('SSV_KEYS_URL override removed (gstatic keys back in charge)', del.ok, `HTTP ${del.status}`)
    ssvKeyInstalled = false
  }
} finally {
  console.log('\nCleaning up (settings restored, ad_test_mode → false)...')
  await cleanup()
}

h.finish('AD-REWARDS')
