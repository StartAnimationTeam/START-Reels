#!/usr/bin/env node
/**
 * Assert the applied schema is what the migrations claim.
 *
 * Not a substitute for scripts/test-rls.mjs — that proves isolation works at
 * runtime with real tokens. This proves the structure exists at all: tables
 * present, RLS switched on everywhere, no SECURITY DEFINER function left
 * executable by a public role.
 *
 * The last check is the one that matters most. Postgres grants EXECUTE to
 * PUBLIC on every function it creates, PostgREST exposes them all at
 * /rest/v1/rpc/, and ours take a p_user_id. Miss a revoke and anyone holding
 * the publishable key can move anyone's credits. (CLAUDE.md trap #7)
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const REF = process.env.SUPABASE_PROJECT_REF

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(JSON.parse(text).message ?? text)
  return text ? JSON.parse(text) : []
}

/** Returns the error message (or null on success) instead of throwing. */
async function sqlError(query) {
  try {
    await sql(query)
    return null
  } catch (err) {
    return err.message
  }
}

let failed = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`)
  if (!ok) failed++
}

console.log('\nSchema verification\n')

// ── tables present, RLS on ────────────────────────────────────────────────
const EXPECTED = [
  'profiles', 'user_roles', 'user_role_audit', 'creator_applications',
  'notification_preferences', 'credit_ledger', 'platform_settings',
  'audit_logs', 'processed_webhook_events',
  // Phase 2
  'videos', 'categories', 'video_categories', 'tags', 'video_tags',
  'upload_sessions', 'video_entitlements', 'watch_sessions', 'watch_history',
  // Phase 3
  'favorites',
  // Phase 4
  'daily_reward_claims',
  // Series pivot (0017)
  'series', 'series_categories', 'series_tags', 'series_follows', 'episode_likes',
]

const tables = await sql(`
  select relname as name, relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
`)
const byName = new Map(tables.map((t) => [t.name, t]))

console.log('Tables:')
for (const t of EXPECTED) {
  check(`${t} exists`, byName.has(t))
}

console.log('\nRLS enabled on every table:')
// No exclusions. Every table in the public schema is reachable through
// PostgREST, so "this one doesn't matter" is never true.
const noRls = tables.filter((t) => !t.rls).map((t) => t.name)
check('no table has RLS off', noRls.length === 0, `off for: ${noRls.join(', ')}`)

// ── the important one ─────────────────────────────────────────────────────
console.log('\nSECURITY DEFINER functions are not publicly executable:')
const leaky = await sql(`
  select p.proname as name,
         array_to_string(array(
           select r.rolname from pg_roles r
           where has_function_privilege(r.rolname, p.oid, 'EXECUTE')
             and r.rolname in ('anon','authenticated','public')
         ), ', ') as roles
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and pg_get_function_identity_arguments(p.oid) ilike '%p_user_id%'
`)
const exposed = leaky.filter((f) => f.roles)
check(
  'no user-id-taking definer function is callable by anon/authenticated',
  exposed.length === 0,
  exposed.map((f) => `${f.name} -> ${f.roles}`).join('; '),
)

// ── views must not bypass RLS ─────────────────────────────────────────────
// A view runs as its OWNER unless security_invoker is set, so a view over an
// RLS-protected table silently exposes every row. This is how credit_balances
// leaked every user's balance until 0004. Checked for ALL views so a new one
// cannot reintroduce it.
console.log('\nViews run as the caller (security_invoker):')
const views = await sql(`
  select c.relname as name,
         coalesce(
           (select option_value from pg_options_to_table(c.reloptions)
            where option_name = 'security_invoker'),
           'off'
         ) as invoker
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
`)
for (const v of views) {
  check(`${v.name} has security_invoker on`, v.invoker === 'true' || v.invoker === 'on', `is '${v.invoker}'`)
}
if (views.length === 0) check('at least one view exists to check', false, 'no views found')

// ── audit log is append-only ──────────────────────────────────────────────
console.log('\nAudit log is append-only:')
const auditWriters = await sql(`
  select array_to_string(array(
    select r.rolname from pg_roles r
    where (has_table_privilege(r.rolname, 'public.audit_logs', 'UPDATE')
        or has_table_privilege(r.rolname, 'public.audit_logs', 'DELETE'))
      and r.rolname in ('anon','authenticated','service_role')
  ), ', ') as roles
`)
check(
  'UPDATE/DELETE revoked from anon, authenticated and service_role',
  !auditWriters[0]?.roles,
  `still held by: ${auditWriters[0]?.roles}`,
)

// ── the GUID column grant ─────────────────────────────────────────────────
// provider_asset_id is the thing signed URLs exist to protect. RLS hides
// rows; only a COLUMN grant hides a column — assert clients cannot select it.
console.log('\nprovider_asset_id is not client-selectable:')
const colGrant = await sql(`
  select array_to_string(array(
    select grantee from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'videos'
      and column_name = 'provider_asset_id'
      and privilege_type = 'SELECT'
      and grantee in ('anon', 'authenticated')
  ), ', ') as grantees
`)
check(
  'neither anon nor authenticated can SELECT videos.provider_asset_id',
  !colGrant[0]?.grantees,
  `granted to: ${colGrant[0]?.grantees}`,
)

// ── the series episode columns ARE granted ────────────────────────────────
// The inverse of the GUID check. 0005 revoked SELECT on videos wholesale and
// granted back an allowlist, so a column added without its own grant is
// silently invisible to clients — embedded selects omit it, explicit selects
// error. Forgetting the grant is the failure mode; assert it positively.
console.log('\nseries_id / episode_number are client-selectable:')
for (const col of ['series_id', 'episode_number', 'like_count']) {
  const grant = await sql(`
    select array_to_string(array(
      select grantee from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'videos'
        and column_name = '${col}'
        and privilege_type = 'SELECT'
        and grantee in ('anon', 'authenticated')
      order by grantee
    ), ', ') as grantees
  `)
  check(
    `videos.${col} SELECT-granted to anon + authenticated`,
    grant[0]?.grantees === 'anon, authenticated',
    `granted to: ${grant[0]?.grantees || 'nobody'}`,
  )
}

// series.search_tsv must be selectable too — PostgREST requires SELECT on any
// WHERE-clause column, so withholding it breaks .textSearch() (the 0008 lesson).
const seriesTsv = await sql(`
  select count(*)::int as n from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'series'
    and column_name = 'search_tsv' and privilege_type = 'SELECT'
    and grantee in ('anon', 'authenticated')
`)
check('series.search_tsv SELECT-granted (FTS works)', seriesTsv[0].n === 2, `${seriesTsv[0].n}/2 grants`)

// ── the tier<->cost invariant (0017 shape) ────────────────────────────────
// free is still welded to zero; the paid range widened to 1..20 so episode
// cost snapshots fit. Probe all three edges.
console.log('\nTier<->cost CHECK constraint:')
const badTier = await sqlError(`
  insert into public.videos (title, slug, creator_id, access_tier, credit_cost)
  values ('bad', 'db-verify-bad-tier', 'db_verify', 'free', 3)
`)
check('a free video with a nonzero cost is refused', Boolean(badTier), 'INSERT SUCCEEDED')

const zeroPremium = await sqlError(`
  insert into public.videos (title, slug, creator_id, access_tier, credit_cost)
  values ('bad', 'db-verify-bad-tier', 'db_verify', 'premium', 0)
`)
check('a premium video with zero cost is refused', Boolean(zeroPremium), 'INSERT SUCCEEDED')

const widePremium = await sqlError(`
  insert into public.videos (title, slug, creator_id, access_tier, credit_cost)
  values ('ok', 'db-verify-bad-tier', 'db_verify', 'premium', 3)
`)
check('a premium video costing 3 is now allowed (widened range)', !widePremium, widePremium ?? '')
await sql(`delete from public.videos where slug = 'db-verify-bad-tier'`)

// ── one EP.n per series ───────────────────────────────────────────────────
console.log('\nEpisode numbering:')
const epProbe = await sql(`
  select count(*)::int as n from pg_indexes
  where schemaname = 'public' and indexname = 'videos_series_episode_idx'
`)
check('unique (series_id, episode_number) index exists', epProbe[0].n === 1)

const orphans = await sql(`
  select count(*)::int as n from public.videos
  where series_id is null and deleted_at is null
`)
check('every live video belongs to a series (0018 backfill)', orphans[0].n === 0, `${orphans[0].n} orphan(s)`)

// ── series trending MV ────────────────────────────────────────────────────
// refresh … CONCURRENTLY silently starts failing in the hourly cron if the
// unique index is missing — assert both halves.
console.log('\nSeries trending MV:')
const mvIdx = await sql(`
  select count(*)::int as n from pg_indexes
  where schemaname = 'public' and tablename = 'mv_trending_series'
    and indexdef ilike 'create unique index%'
`)
check('mv_trending_series exists with a unique index', mvIdx[0].n >= 1)

let refreshOk = false
try {
  await sql(`select public.refresh_trending()`)
  refreshOk = true
} catch (err) {
  check('refresh_trending() runs both MVs', false, err.message)
}
if (refreshOk) check('refresh_trending() runs both MVs', true)

// ── pg_cron jobs scheduled ────────────────────────────────────────────────
console.log('\nCron jobs:')
for (const jobname of ['sweep-stale-holds', 'publish-scheduled-series']) {
  try {
    const jobs = await sql(`select jobname from cron.job where jobname = '${jobname}'`)
    check(`${jobname} is scheduled in pg_cron`, jobs.length === 1)
  } catch {
    check(`${jobname} is scheduled in pg_cron`, false, 'pg_cron schema missing')
  }
}

// ── settings seeded ───────────────────────────────────────────────────────
console.log('\nPlatform settings:')
const settings = await sql(`select count(*)::int as n from public.platform_settings`)
check('settings seeded', settings[0].n >= 12, `found ${settings[0].n}`)

const window = await sql(`
  select value #>> '{}' as v from public.platform_settings where key = 'entitlement_window_hours'
`)
check('entitlement window is ~permanent (87600h, the 0019 pivot)', window[0]?.v === '87600', `got ${window[0]?.v}`)

const settle = await sql(`
  select value #>> '{}' as v from public.platform_settings where key = 'settle_after_seconds'
`)
check('settle threshold retuned for short episodes (10s)', settle[0]?.v === '10', `got ${settle[0]?.v}`)

const ladder = await sql(`
  select value as v from public.platform_settings where key = 'daily_reward_ladder'
`)
const rungs = ladder[0]?.v
check(
  'daily_reward_ladder is 7 positive-int rungs',
  Array.isArray(rungs) && rungs.length === 7 && rungs.every((n) => Number.isInteger(n) && n >= 1),
  `got ${JSON.stringify(rungs)}`,
)

// ── ledger round trip ─────────────────────────────────────────────────────
console.log('\nLedger behaviour:')
const probe = 'verify_probe_user'
await sql(`delete from public.credit_ledger where user_id = '${probe}'`)

await sql(`select public.grant_credits('${probe}', 10, 'admin_grant', null, null, 'watch', 'verify:1', '{}'::jsonb)`)
await sql(`select public.grant_credits('${probe}', 10, 'admin_grant', null, null, 'watch', 'verify:1', '{}'::jsonb)`)
const afterDouble = await sql(`select public.available_credits('${probe}', 'watch') as bal`)
check(
  'a replayed grant with the same idempotency key does not double',
  Number(afterDouble[0].bal) === 10,
  `balance is ${afterDouble[0].bal}, expected 10`,
)

const hold = await sql(`
  select public.reserve_credits('${probe}', 'watch', 3, 'watch_debit', 'video_unlock', 'probe') as id
`)
const held = await sql(`select public.available_credits('${probe}', 'watch') as bal`)
check('a hold immediately reduces available balance', Number(held[0].bal) === 7, `got ${held[0].bal}`)

await sql(`select public.settle_credit_hold('${hold[0].id}', false)`)
const reversed = await sql(`select public.available_credits('${probe}', 'watch') as bal`)
check('reversing a hold restores the balance', Number(reversed[0].bal) === 10, `got ${reversed[0].bal}`)

let overspendBlocked = false
try {
  await sql(`select public.reserve_credits('${probe}', 'watch', 999, 'watch_debit', 'video_unlock', 'probe')`)
} catch (err) {
  overspendBlocked = err.message.includes('insufficient_credits')
}
check('overspending raises insufficient_credits', overspendBlocked)

await sql(`delete from public.credit_ledger where user_id = '${probe}'`)

console.log(failed === 0 ? '\nSchema OK.\n' : `\n${failed} check(s) failed.\n`)
process.exit(failed === 0 ? 0 : 1)
