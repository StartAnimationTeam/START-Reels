import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.111.0'

/**
 * Webhook idempotency: claim-first.
 *
 * Webhooks are AT-LEAST-ONCE. Every sender retries, and a retry that re-runs
 * the work is how the sibling project silently double-granted signup credits —
 * the balance view just quietly doubled, with nothing in the logs saying so.
 *
 * The protocol:
 *   1. `claim()` INSERTs the event id BEFORE any work happens. A duplicate hits
 *      the primary key and returns `already_processed`.
 *   2. On a duplicate, answer **200**. A non-2xx makes the sender retry, and on
 *      a replay that loops forever.
 *   3. `complete()` on success, `release()` on failure — so a transient error
 *      can legitimately be retried rather than being permanently swallowed by
 *      its own claim row.
 */

export type ClaimResult = 'claimed' | 'already_processed'

export async function claim(
  db: SupabaseClient,
  eventId: string,
  source: 'clerk' | 'bunny' | 'paymongo',
  eventType?: string,
): Promise<ClaimResult> {
  const { error } = await db
    .from('processed_webhook_events')
    .insert({ event_id: eventId, source, event_type: eventType ?? null })

  if (!error) return 'claimed'

  // 23505 = unique_violation. Anything else is a real failure and should throw,
  // because silently treating a dead database as "already processed" would drop
  // the event entirely.
  if (error.code === '23505') return 'already_processed'
  throw new Error(`webhook_claim_failed: ${error.message}`)
}

export async function complete(db: SupabaseClient, eventId: string): Promise<void> {
  await db
    .from('processed_webhook_events')
    .update({ completed_at: new Date().toISOString() })
    .eq('event_id', eventId)
}

/**
 * Release a claim whose work failed, so the sender's retry can pick it up.
 * The error is recorded first: a claim row that vanishes without trace turns a
 * failing webhook into an invisible one.
 */
export async function release(
  db: SupabaseClient,
  eventId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  await db.from('processed_webhook_events').update({ error: message }).eq('event_id', eventId)
  await db.from('processed_webhook_events').delete().eq('event_id', eventId)
}
