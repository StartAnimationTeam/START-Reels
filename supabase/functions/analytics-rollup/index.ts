import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST — run the daily rollup and reconcile against Bunny.
 *
 * The SQL rollup itself runs nightly inside Postgres via pg_cron and needs
 * nothing from here. This endpoint adds the parts SQL cannot do — calling
 * Bunny — and doubles as the ops "recompute now" button:
 *
 *   1. rollup_daily_stats(day)        (idempotent upsert; ?day=YYYY-MM-DD)
 *   2. Bunny statistics → bunny_watch_seconds for that day. OUR heartbeats
 *      are primary; Bunny's number is the AUDIT. A large divergence means a
 *      broken client, not a rounding difference (CLAUDE.md trap #10).
 *   3. Library storage usage → storage_bytes (the admin storage tile — on a
 *      per-GB-billed vendor, unwatched storage is the quiet cost).
 *
 * Secret-gated like credits-sweep: no user may trigger recomputation.
 */

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)

  const secret = Deno.env.get('SWEEP_TRIGGER_SECRET')
  if (!secret) return fail(req, 'rollup_not_configured', 500)
  if (req.headers.get('x-sweep-secret') !== secret) return fail(req, 'unauthorized', 401)

  const url = new URL(req.url)
  const dayParam = url.searchParams.get('day') // optional YYYY-MM-DD

  const db = serviceClient()

  // 1. the SQL rollup
  const { data: rollup, error } = await db.rpc('rollup_daily_stats', {
    p_day: dayParam ?? undefined,
  })
  if (error) return fail(req, 'rollup_failed', 500, error.message)
  const day = (rollup as { day: string }).day

  // 2 + 3. Bunny reconciliation — best-effort: a Bunny outage must not fail
  // the rollup, only leave the audit columns null for the day.
  let bunnyWatchSeconds: number | null = null
  let storageBytes: number | null = null

  const libraryId = Deno.env.get('BUNNY_STREAM_LIBRARY_ID')
  const apiKey = Deno.env.get('BUNNY_STREAM_API_KEY')
  const accountKey = Deno.env.get('BUNNY_ACCOUNT_API_KEY')

  if (libraryId && apiKey) {
    try {
      const stats = await fetch(
        `https://video.bunnycdn.com/library/${libraryId}/statistics?dateFrom=${day}&dateTo=${day}`,
        { headers: { AccessKey: apiKey } },
      )
      if (stats.ok) {
        const body = (await stats.json()) as { watchTimeChart?: Record<string, number> }
        const chart = body.watchTimeChart ?? {}
        // chart values are minutes per bucket; sum the day
        const minutes = Object.values(chart).reduce((sum, v) => sum + Number(v || 0), 0)
        bunnyWatchSeconds = Math.round(minutes * 60)
      }
    } catch {
      /* audit column stays null */
    }
  }

  if (libraryId && accountKey) {
    try {
      const lib = await fetch(`https://api.bunny.net/videolibrary/${libraryId}`, {
        headers: { AccessKey: accountKey },
      })
      if (lib.ok) {
        const body = (await lib.json()) as { StorageUsage?: number }
        storageBytes = Number(body.StorageUsage ?? 0)
      }
    } catch {
      /* audit column stays null */
    }
  }

  await db
    .from('platform_daily_stats')
    .update({ bunny_watch_seconds: bunnyWatchSeconds, storage_bytes: storageBytes })
    .eq('day', day)

  // Refresh trending while we're here — the ops button should leave
  // everything current, not just the tables.
  await db.rpc('refresh_trending')

  const ours = Number((rollup as { watch_seconds: number }).watch_seconds ?? 0)
  const divergence =
    bunnyWatchSeconds !== null && ours > 0
      ? Math.abs(ours - bunnyWatchSeconds) / ours
      : null

  return json(req, {
    ok: true,
    day,
    rollup,
    bunny_watch_seconds: bunnyWatchSeconds,
    storage_bytes: storageBytes,
    // >20% should page a human (trap #10) — surfaced here, judged by the caller
    watch_time_divergence: divergence,
  })
})
