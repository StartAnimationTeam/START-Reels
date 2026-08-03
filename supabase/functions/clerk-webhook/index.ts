import { Webhook } from 'npm:svix@1.42.0'

import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'
import { claim, complete, release } from '../_shared/webhooks.ts'

/**
 * Clerk → Supabase user sync.
 *
 * Handles user.created / user.updated / user.deleted:
 *   created  → profile row, default notification prefs, signup credit grant
 *   updated  → refresh the denormalized email + display name
 *   deleted  → soft-delete the profile (the ledger is append-only and stays)
 *
 * Two things this function exists to get right:
 *
 * 1. **Signature verification.** The payload is untrusted until svix says
 *    otherwise. Anyone who learns this URL could otherwise POST themselves a
 *    profile and a credit grant.
 *
 * 2. **Idempotency.** Clerk retries. `claim()` runs before any work and the
 *    grant itself carries an idempotency key, so the credit path is protected
 *    twice over — once at the event and once at the ledger. That redundancy is
 *    deliberate: the sibling project had neither and double-granted.
 *
 * config.toml sets verify_jwt = false for this function — a webhook has no
 * Clerk session token, so the platform's JWT gate would 401 it before this code
 * ran.
 */

const WEBHOOK_SECRET = Deno.env.get('CLERK_WEBHOOK_SECRET')

interface ClerkEmail {
  id: string
  email_address: string
  verification?: { status?: string } | null
}

interface ClerkUserData {
  id: string
  email_addresses?: ClerkEmail[]
  primary_email_address_id?: string | null
  first_name?: string | null
  last_name?: string | null
  username?: string | null
  image_url?: string | null
  deleted?: boolean
}

interface ClerkEvent {
  type: string
  data: ClerkUserData
}

function primaryEmail(data: ClerkUserData): string | null {
  const list = data.email_addresses ?? []
  if (list.length === 0) return null
  const primary = list.find((e) => e.id === data.primary_email_address_id)
  return (primary ?? list[0]).email_address ?? null
}

function displayName(data: ClerkUserData): string | null {
  const full = [data.first_name, data.last_name].filter(Boolean).join(' ').trim()
  return full || data.username || null
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)
  if (!WEBHOOK_SECRET) return fail(req, 'webhook_not_configured', 500)

  // svix needs the RAW body — parsing and re-stringifying changes the bytes and
  // the signature no longer matches.
  const raw = await req.text()
  const svixId = req.headers.get('svix-id')
  const svixTimestamp = req.headers.get('svix-timestamp')
  const svixSignature = req.headers.get('svix-signature')

  if (!svixId || !svixTimestamp || !svixSignature) {
    return fail(req, 'missing_signature_headers', 400)
  }

  let event: ClerkEvent
  try {
    event = new Webhook(WEBHOOK_SECRET).verify(raw, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as ClerkEvent
  } catch {
    return fail(req, 'invalid_signature', 401)
  }

  const db = serviceClient()

  // ── claim before work ───────────────────────────────────────────────────
  let claimState: 'claimed' | 'already_processed'
  try {
    claimState = await claim(db, svixId, 'clerk', event.type)
  } catch (err) {
    return fail(req, 'claim_failed', 500, err instanceof Error ? err.message : undefined)
  }

  // 200, deliberately. A non-2xx makes svix retry, and on a replay that loops.
  if (claimState === 'already_processed') {
    return json(req, { ok: true, replay: true })
  }

  try {
    switch (event.type) {
      case 'user.created':
        await onUserCreated(db, event.data)
        break
      case 'user.updated':
        await onUserUpdated(db, event.data)
        break
      case 'user.deleted':
        await onUserDeleted(db, event.data)
        break
      default:
        // Unhandled types still keep their claim row: they were genuinely
        // received, and re-delivering them would do nothing useful.
        break
    }

    await complete(db, svixId)
    return json(req, { ok: true })
  } catch (err) {
    await release(db, svixId, err)
    return fail(req, 'processing_failed', 500, err instanceof Error ? err.message : undefined)
  }
})

async function onUserCreated(
  db: ReturnType<typeof serviceClient>,
  data: ClerkUserData,
): Promise<void> {
  const email = primaryEmail(data)
  if (!email) throw new Error('user_created_without_email')

  // upsert, not insert: a replayed-but-unclaimed event (say the claim row was
  // released after a partial failure) must not fail on the primary key.
  const { error: profileError } = await db.from('profiles').upsert(
    {
      user_id: data.id,
      email,
      display_name: displayName(data),
    },
    { onConflict: 'user_id' },
  )
  if (profileError) throw new Error(`profile_upsert_failed: ${profileError.message}`)

  const { error: prefsError } = await db
    .from('notification_preferences')
    .upsert({ user_id: data.id }, { onConflict: 'user_id' })
  if (prefsError) throw new Error(`prefs_upsert_failed: ${prefsError.message}`)

  // ── signup grant ────────────────────────────────────────────────────────
  const { data: settingRow } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'signup_grant_credits')
    .maybeSingle()

  const amount = Number(settingRow?.value ?? 0)
  if (amount <= 0) return

  // Second layer of idempotency. The claim row above should already prevent a
  // replay reaching here, but the ledger is the thing that must never be wrong,
  // so it carries its own key: a grant for this user's signup can exist once,
  // no matter how the caller got here.
  const { error: grantError } = await db.rpc('grant_credits', {
    p_user_id: data.id,
    p_amount: amount,
    p_reason: 'signup_grant',
    p_reference_type: 'clerk_event',
    p_reference_id: data.id,
    p_credit_type: 'watch',
    p_idempotency_key: `signup:${data.id}`,
    p_metadata: { source: 'clerk-webhook' },
  })
  if (grantError) throw new Error(`signup_grant_failed: ${grantError.message}`)
}

async function onUserUpdated(
  db: ReturnType<typeof serviceClient>,
  data: ClerkUserData,
): Promise<void> {
  const email = primaryEmail(data)

  const patch: Record<string, unknown> = { display_name: displayName(data) }
  if (email) patch.email = email

  const { error } = await db.from('profiles').update(patch).eq('user_id', data.id)
  if (error) throw new Error(`profile_update_failed: ${error.message}`)
}

async function onUserDeleted(
  db: ReturnType<typeof serviceClient>,
  data: ClerkUserData,
): Promise<void> {
  // Soft delete. The ledger is append-only and their watch history feeds
  // platform analytics — hard-deleting the profile would either orphan those
  // rows or force a cascade that rewrites history.
  const { error } = await db
    .from('profiles')
    .update({ deleted_at: new Date().toISOString() })
    .eq('user_id', data.id)
  if (error) throw new Error(`profile_soft_delete_failed: ${error.message}`)
}
