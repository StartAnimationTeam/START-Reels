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
 *   create_category   { name, sortOrder? }
 *   update_category   { categoryId, name?, sortOrder?, active? }
 *   delete_category   { categoryId }   — detaches from every series (FK cascade)
 *   create_tag        { name }         — a facet ("Secret Baby", "Revenge", …)
 *   delete_tag        { tagId }        — detaches from every series (FK cascade)
 *
 * Taxonomy lives here because it IS platform config: the pickers (series
 * editor, search chips, home tabs) all read these tables live, so a new
 * category or facet is usable everywhere the moment it exists.
 *
 * update_setting is allowlisted: only keys with a defined meaning may change,
 * and each has a validator. A settings endpoint that writes arbitrary keys is
 * a config-injection surface wearing a friendly name.
 */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

const SETTING_RULES: Record<string, (v: unknown) => boolean> = {
  maintenance_mode: (v) => typeof v === 'boolean',
  signup_grant_credits: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100,
  daily_reward_amount: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 20,
  daily_reward_enabled: (v) => typeof v === 'boolean',
  // 131400h = 15 years. Since the series pivot (0019) unlocks are effectively
  // permanent (87600h); the old 720 cap would make the live value unsettable
  // from this very endpoint.
  entitlement_window_hours: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 131400,
  settle_after_seconds: (v) => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 600,
  max_concurrent_streams: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10,
  // Check-in ladder: exactly 7 positive-int rungs (0020 cycles past day 7).
  daily_reward_ladder: (v) =>
    Array.isArray(v) && v.length === 7 &&
    v.every((n) => Number.isInteger(n) && n >= 1 && n <= 50),
  // Rewarded ads (0027). ad_test_mode arms ads-ssv's unsigned test rail —
  // leave false outside of test runs; the secret header alone is not enough.
  ad_rewards_enabled: (v) => typeof v === 'boolean',
  ad_test_mode: (v) => typeof v === 'boolean',
  ad_reward_amount: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100,
  ad_reward_daily_cap: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100,
  ad_reward_min_interval_seconds: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3600,
  // Membership passes (0030). Prices in centavos, ₱1–₱100k per tier;
  // methods limited to what PayMongo checkout actually accepts here.
  membership_passes_enabled: (v) => typeof v === 'boolean',
  membership_pass_prices: (v) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    ['weekly', 'monthly', 'annual'].every((t) => {
      const n = (v as Record<string, unknown>)[t]
      return Number.isInteger(n) && (n as number) >= 100 && (n as number) <= 10_000_000
    }),
  membership_pass_methods: (v) =>
    Array.isArray(v) && v.length >= 1 &&
    v.every((m) => ['qrph', 'gcash', 'paymaya', 'card'].includes(m as string)),
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
  categoryId?: string
  tagId?: string
  sortOrder?: number
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

    case 'create_category': {
      const name = String(body.name ?? '').trim()
      if (!name || name.length > 80) return fail(req, 'bad_request', 400)
      const slug = slugify(name)
      if (!slug) return fail(req, 'bad_request', 400)
      const { data: category, error } = await db
        .from('categories')
        .insert({
          name: name.slice(0, 80),
          slug,
          sort_order: Number.isInteger(body.sortOrder) ? body.sortOrder : 100,
          is_active: true,
        })
        .select('id, slug, name')
        .single()
      if (error) {
        if (error.code === '23505') return fail(req, 'category_exists', 409)
        return fail(req, 'update_failed', 500, error.message)
      }
      await audit(db, ctx.userId, 'taxonomy.category_created', 'category', category.id, null, category)
      return json(req, { ok: true, category })
    }

    case 'update_category': {
      const id = body.categoryId
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return fail(req, 'bad_request', 400)
      const { data: before } = await db
        .from('categories').select('id, name, sort_order, is_active').eq('id', id).maybeSingle()
      if (!before) return fail(req, 'not_found', 404)

      const patch: Record<string, unknown> = {}
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 80)
      if (Number.isInteger(body.sortOrder)) patch.sort_order = body.sortOrder
      if (typeof body.active === 'boolean') patch.is_active = body.active
      if (!Object.keys(patch).length) return fail(req, 'bad_request', 400)

      const { data: after, error } = await db
        .from('categories').update(patch).eq('id', id).select('id, name, sort_order, is_active').single()
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, ctx.userId, 'taxonomy.category_updated', 'category', id, before, after)
      return json(req, { ok: true, category: after })
    }

    case 'delete_category': {
      const id = body.categoryId
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return fail(req, 'bad_request', 400)
      const { data: before } = await db
        .from('categories').select('id, slug, name').eq('id', id).maybeSingle()
      if (!before) return fail(req, 'not_found', 404)

      // How many series lose this chip — recorded in the audit so a
      // mistaken delete is reconstructable.
      const { count } = await db
        .from('series_categories')
        .select('series_id', { count: 'exact', head: true })
        .eq('category_id', id)

      const { error } = await db.from('categories').delete().eq('id', id)
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, ctx.userId, 'taxonomy.category_deleted', 'category', id, before,
        { detached_from_series: count ?? 0 })
      return json(req, { ok: true, detached_from_series: count ?? 0 })
    }

    case 'create_tag': {
      const name = String(body.name ?? '').trim()
      if (!name || name.length > 60) return fail(req, 'bad_request', 400)
      const slug = slugify(name)
      if (!slug) return fail(req, 'bad_request', 400)
      const { data: tag, error } = await db
        .from('tags')
        .insert({ name: name.slice(0, 60), slug })
        .select('id, slug, name')
        .single()
      if (error) {
        if (error.code === '23505') return fail(req, 'tag_exists', 409)
        return fail(req, 'update_failed', 500, error.message)
      }
      await audit(db, ctx.userId, 'taxonomy.tag_created', 'tag', tag.id, null, tag)
      return json(req, { ok: true, tag })
    }

    case 'delete_tag': {
      const id = body.tagId
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return fail(req, 'bad_request', 400)
      const { data: before } = await db.from('tags').select('id, slug, name').eq('id', id).maybeSingle()
      if (!before) return fail(req, 'not_found', 404)

      const { count } = await db
        .from('series_tags')
        .select('series_id', { count: 'exact', head: true })
        .eq('tag_id', id)

      const { error } = await db.from('tags').delete().eq('id', id)
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, ctx.userId, 'taxonomy.tag_deleted', 'tag', id, before,
        { detached_from_series: count ?? 0 })
      return json(req, { ok: true, detached_from_series: count ?? 0 })
    }

    default:
      return fail(req, 'bad_request', 400)
  }
})
