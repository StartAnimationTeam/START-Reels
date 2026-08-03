import { AuthError } from '../_shared/auth.ts'
import { audit, requireStaffContext } from '../_shared/admin.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST { action, userId, ... } — user administration.
 *
 *   set_role        grant/revoke creator|moderator|administrator  (admin)
 *   suspend         with reason, optional until                   (moderator+)
 *   unsuspend                                                     (moderator+)
 *   ban / unban     with reason                                   (admin)
 *   grant_credits   positive amount, reason recorded              (admin)
 *   deduct_credits  positive amount, becomes a negative row       (admin)
 *
 * Two self-protection rules, both deliberate:
 *   - nobody may suspend, ban, or de-admin THEMSELF — the classic way a
 *     platform locks out its last administrator at 2am;
 *   - role changes are admin-only, so a moderator can never mint peers.
 *
 * Credits use `manual_adjustment` and land committed immediately: an admin
 * grant is a decision, not a hold. The append-only ledger plus the audit row
 * (written before success is reported) is the paper trail.
 */

interface Body {
  action?: string
  userId?: string
  role?: 'creator' | 'moderator' | 'administrator'
  grant?: boolean
  reason?: string
  until?: string
  amount?: number
  note?: string
  applicationId?: string
  approve?: boolean
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)

  const db = serviceClient()

  let ctx
  try {
    ctx = await requireStaffContext(req, db)
  } catch (err) {
    const code = err instanceof AuthError ? err.code : 'unauthorized'
    return fail(req, code, code === 'forbidden' ? 403 : 401)
  }

  let body: Body
  try {
    body = await req.json()
  } catch {
    return fail(req, 'bad_request', 400)
  }

  // ── creator applications ────────────────────────────────────────────────
  // Handled before the target-profile lookup: the action names an
  // APPLICATION, and the user comes from its row — taking a separate userId
  // would let the two disagree.
  if (body.action === 'decide_application') {
    const appId = body.applicationId
    if (typeof appId !== 'string' || !/^[0-9a-f-]{36}$/.test(appId)) {
      return fail(req, 'bad_request', 400)
    }

    const { data: application } = await db
      .from('creator_applications')
      .select('id, user_id, status')
      .eq('id', appId)
      .maybeSingle()
    if (!application) return fail(req, 'not_found', 404)
    // Deciding a decided application would silently rewrite history.
    if (application.status !== 'pending') return fail(req, 'already_decided', 409)

    const approve = body.approve === true
    const { error: decideErr } = await db
      .from('creator_applications')
      .update({
        status: approve ? 'approved' : 'rejected',
        reviewed_by: ctx.userId,
        reviewed_at: new Date().toISOString(),
        decision_note: (body.note ?? '').slice(0, 500) || null,
      })
      .eq('id', appId)
      .eq('status', 'pending') // guard against a raced double-decision
    if (decideErr) return fail(req, 'update_failed', 500, decideErr.message)

    if (approve) {
      const { error: roleErr } = await db
        .from('user_roles')
        .upsert(
          { user_id: application.user_id, role: 'creator', granted_by: ctx.userId },
          { onConflict: 'user_id,role' },
        )
      if (roleErr) return fail(req, 'update_failed', 500, roleErr.message)
    }

    await audit(db, ctx.userId, `creator_application.${approve ? 'approved' : 'rejected'}`,
      'creator_application', appId, { user_id: application.user_id }, { approve, note: body.note ?? null })
    return json(req, { ok: true, approved: approve })
  }

  const targetId = body.userId
  if (typeof targetId !== 'string' || !targetId.startsWith('user_')) {
    return fail(req, 'bad_request', 400)
  }

  const { data: target } = await db
    .from('profiles')
    .select('user_id, email, display_name, suspended_at, suspended_reason, banned_at')
    .eq('user_id', targetId)
    .maybeSingle()
  if (!target) return fail(req, 'not_found', 404)

  const actingOnSelf = targetId === ctx.userId

  switch (body.action) {
    // ── roles ────────────────────────────────────────────────────────────
    case 'set_role': {
      if (!ctx.isAdmin) return fail(req, 'forbidden', 403)
      const role = body.role
      if (!role || !['creator', 'moderator', 'administrator'].includes(role)) {
        return fail(req, 'bad_request', 400)
      }
      if (actingOnSelf && role === 'administrator' && body.grant === false) {
        return fail(req, 'cannot_demote_self', 400)
      }

      if (body.grant === false) {
        const { error } = await db.from('user_roles').delete().eq('user_id', targetId).eq('role', role)
        if (error) return fail(req, 'update_failed', 500, error.message)
      } else {
        const { error } = await db
          .from('user_roles')
          .upsert({ user_id: targetId, role, granted_by: ctx.userId }, { onConflict: 'user_id,role' })
        if (error) return fail(req, 'update_failed', 500, error.message)
      }
      // user_role_audit is written by trigger; audit_logs records the actor's
      // intent alongside it.
      await audit(db, ctx.userId, `user.role_${body.grant === false ? 'revoked' : 'granted'}`, 'user', targetId, null, { role })
      return json(req, { ok: true })
    }

    // ── moderation state ─────────────────────────────────────────────────
    case 'suspend': {
      if (actingOnSelf) return fail(req, 'cannot_moderate_self', 400)
      const patch = {
        suspended_at: new Date().toISOString(),
        suspended_by: ctx.userId,
        suspended_reason: (body.reason ?? 'suspended').slice(0, 500),
        suspended_until: body.until ?? null,
      }
      const { error } = await db.from('profiles').update(patch).eq('user_id', targetId)
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, ctx.userId, 'user.suspend', 'user', targetId,
        { suspended_at: target.suspended_at }, patch)
      return json(req, { ok: true })
    }
    case 'unsuspend': {
      const patch = { suspended_at: null, suspended_by: null, suspended_reason: null, suspended_until: null }
      const { error } = await db.from('profiles').update(patch).eq('user_id', targetId)
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, ctx.userId, 'user.unsuspend', 'user', targetId,
        { suspended_at: target.suspended_at, reason: target.suspended_reason }, patch)
      return json(req, { ok: true })
    }
    case 'ban': {
      if (!ctx.isAdmin) return fail(req, 'forbidden', 403)
      if (actingOnSelf) return fail(req, 'cannot_moderate_self', 400)
      const patch = {
        banned_at: new Date().toISOString(),
        banned_by: ctx.userId,
        banned_reason: (body.reason ?? 'banned').slice(0, 500),
      }
      const { error } = await db.from('profiles').update(patch).eq('user_id', targetId)
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, ctx.userId, 'user.ban', 'user', targetId, { banned_at: target.banned_at }, patch)
      return json(req, { ok: true })
    }
    case 'unban': {
      if (!ctx.isAdmin) return fail(req, 'forbidden', 403)
      const patch = { banned_at: null, banned_by: null, banned_reason: null }
      const { error } = await db.from('profiles').update(patch).eq('user_id', targetId)
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, ctx.userId, 'user.unban', 'user', targetId, { banned_at: target.banned_at }, patch)
      return json(req, { ok: true })
    }

    // ── credits ──────────────────────────────────────────────────────────
    case 'grant_credits': {
      if (!ctx.isAdmin) return fail(req, 'forbidden', 403)
      const amount = Number(body.amount)
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) return fail(req, 'bad_request', 400)

      const { data: ledgerId, error } = await db.rpc('grant_credits', {
        p_user_id: targetId,
        p_amount: amount,
        p_reason: 'admin_grant',
        p_reference_type: 'admin_grant',
        p_reference_id: ctx.userId,
        p_credit_type: 'watch',
        p_idempotency_key: null,
        p_metadata: { note: (body.note ?? '').slice(0, 500), granted_by: ctx.userId },
      })
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, ctx.userId, 'user.grant_credits', 'user', targetId, null, { amount, ledger_id: ledgerId })
      return json(req, { ok: true, ledger_id: ledgerId })
    }
    case 'deduct_credits': {
      if (!ctx.isAdmin) return fail(req, 'forbidden', 403)
      const amount = Number(body.amount)
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) return fail(req, 'bad_request', 400)

      // A deliberate negative committed row — not reserve/settle, which is
      // for consumption. This is an administrative correction and says so.
      const { data: row, error } = await db
        .from('credit_ledger')
        .insert({
          user_id: targetId,
          credit_type: 'watch',
          amount: -amount,
          status: 'committed',
          reason: 'manual_adjustment',
          reference_type: 'admin_grant',
          reference_id: ctx.userId,
          metadata: { note: (body.note ?? '').slice(0, 500), deducted_by: ctx.userId },
        })
        .select('id')
        .single()
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, ctx.userId, 'user.deduct_credits', 'user', targetId, null, { amount: -amount, ledger_id: row.id })
      return json(req, { ok: true, ledger_id: row.id })
    }

    default:
      return fail(req, 'bad_request', 400)
  }
})
