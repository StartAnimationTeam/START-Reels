import { AuthError } from '../_shared/auth.ts'
import { audit, requireStaffContext } from '../_shared/admin.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST { action, ... } — platform configuration. ADMINISTRATOR ONLY; audited.
 *
 *   create_promo      { code, name, amount, perUserLimit?, maxRedemptions?, endsAt? }
 *   set_promo_active  { campaignId, active }
 *   update_setting    { key, value }
 *
 * update_setting is allowlisted: only keys with a defined meaning may change,
 * and each has a validator. A settings endpoint that writes arbitrary keys is
 * a config-injection surface wearing a friendly name.
 */

const SETTING_RULES: Record<string, (v: unknown) => boolean> = {
  maintenance_mode: (v) => typeof v === 'boolean',
  signup_grant_credits: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100,
  daily_reward_amount: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 20,
  daily_reward_enabled: (v) => typeof v === 'boolean',
  entitlement_window_hours: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 720,
  settle_after_seconds: (v) => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 600,
  max_concurrent_streams: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10,
}

interface Body {
  action?: string
  code?: string
  name?: string
  amount?: number
  perUserLimit?: number
  maxRedemptions?: number | null
  endsAt?: string | null
  campaignId?: string
  active?: boolean
  key?: string
  value?: unknown
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
  // Platform config moves money-adjacent levers; moderators stop here.
  if (!ctx.isAdmin) return fail(req, 'forbidden', 403)

  let body: Body
  try {
    body = await req.json()
  } catch {
    return fail(req, 'bad_request', 400)
  }

  switch (body.action) {
    case 'create_promo': {
      const code = String(body.code ?? '').toUpperCase().trim()
      const name = String(body.name ?? '').trim()
      const amount = Number(body.amount)
      if (!/^[A-Z0-9-]{3,32}$/.test(code) || !name || !Number.isFinite(amount) || amount <= 0 || amount > 1000) {
        return fail(req, 'bad_request', 400)
      }
      const { data: campaign, error } = await db
        .from('promo_campaigns')
        .insert({
          code,
          name: name.slice(0, 120),
          amount,
          per_user_limit: Number.isInteger(body.perUserLimit) && body.perUserLimit! >= 1 ? body.perUserLimit : 1,
          max_redemptions: Number.isInteger(body.maxRedemptions) && body.maxRedemptions! >= 1 ? body.maxRedemptions : null,
          ends_at: body.endsAt ?? null,
          created_by: ctx.userId,
        })
        .select('id, code')
        .single()
      if (error) {
        if (error.code === '23505') return fail(req, 'promo_code_taken', 409)
        return fail(req, 'update_failed', 500, error.message)
      }
      await audit(db, ctx.userId, 'promo.created', 'promo_campaign', campaign.id, null,
        { code, amount, max_redemptions: body.maxRedemptions ?? null })
      return json(req, { ok: true, campaign })
    }

    case 'set_promo_active': {
      const id = body.campaignId
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return fail(req, 'bad_request', 400)
      const { data: before } = await db
        .from('promo_campaigns').select('id, code, is_active').eq('id', id).maybeSingle()
      if (!before) return fail(req, 'not_found', 404)
      const { error } = await db
        .from('promo_campaigns').update({ is_active: body.active === true }).eq('id', id)
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, ctx.userId, 'promo.toggled', 'promo_campaign', id,
        { is_active: before.is_active }, { is_active: body.active === true })
      return json(req, { ok: true })
    }

    case 'update_setting': {
      const key = String(body.key ?? '')
      const rule = SETTING_RULES[key]
      if (!rule) return fail(req, 'setting_not_editable', 400)
      if (!rule(body.value)) return fail(req, 'bad_request', 400)

      const { data: before } = await db
        .from('platform_settings').select('value').eq('key', key).maybeSingle()
      const { error } = await db
        .from('platform_settings')
        .update({ value: body.value as never, updated_by: ctx.userId, updated_at: new Date().toISOString() })
        .eq('key', key)
      if (error) return fail(req, 'update_failed', 500, error.message)

      await audit(db, ctx.userId, 'settings.updated', 'platform_setting', key,
        { value: before?.value }, { value: body.value })
      return json(req, { ok: true })
    }

    default:
      return fail(req, 'bad_request', 400)
  }
})
