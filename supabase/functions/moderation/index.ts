import { AuthError } from '../_shared/auth.ts'
import { audit, requireStaffContext } from '../_shared/admin.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST { action, ... } — acting on community reports. Staff-wide; audited.
 *
 *   resolve   { reportId, actionTaken }   report → actioned
 *   dismiss   { reportId, note? }         report → dismissed
 *   warn      { userId, reason, severity?, reportId? }   issue a warning
 *
 * Resolving a report records WHAT was done in prose (`action_taken`) —
 * "video removed", "metadata fixed", "warned uploader" — because six months
 * later "actioned" alone answers nothing. Content removal itself stays in
 * admin-videos (it moves money); this function closes the loop on the report.
 */

interface Body {
  action?: string
  reportId?: string
  userId?: string
  actionTaken?: string
  note?: string
  reason?: string
  severity?: 'notice' | 'warning' | 'final'
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

  switch (body.action) {
    case 'resolve':
    case 'dismiss': {
      const reportId = body.reportId
      if (typeof reportId !== 'string' || !/^[0-9a-f-]{36}$/.test(reportId)) {
        return fail(req, 'bad_request', 400)
      }
      const { data: report } = await db
        .from('video_reports')
        .select('id, status, video_id, reporter_id')
        .eq('id', reportId)
        .maybeSingle()
      if (!report) return fail(req, 'not_found', 404)
      if (report.status === 'actioned' || report.status === 'dismissed') {
        return fail(req, 'already_decided', 409)
      }

      const resolved = body.action === 'resolve'
      const actionTaken = resolved
        ? (body.actionTaken ?? 'actioned').slice(0, 500)
        : (body.note ?? 'dismissed').slice(0, 500)

      const { error } = await db
        .from('video_reports')
        .update({
          status: resolved ? 'actioned' : 'dismissed',
          reviewed_by: ctx.userId,
          reviewed_at: new Date().toISOString(),
          action_taken: actionTaken,
        })
        .eq('id', reportId)
        .in('status', ['open', 'reviewing'])
      if (error) return fail(req, 'update_failed', 500, error.message)

      await audit(db, ctx.userId, `report.${resolved ? 'resolved' : 'dismissed'}`, 'video_report',
        reportId, { status: report.status }, { action_taken: actionTaken, video_id: report.video_id })
      return json(req, { ok: true })
    }

    case 'warn': {
      const targetId = body.userId
      if (typeof targetId !== 'string' || !targetId.startsWith('user_')) {
        return fail(req, 'bad_request', 400)
      }
      if (targetId === ctx.userId) return fail(req, 'cannot_moderate_self', 400)
      const reason = (body.reason ?? '').trim()
      if (!reason) return fail(req, 'bad_request', 400)

      const { data: target } = await db
        .from('profiles')
        .select('user_id')
        .eq('user_id', targetId)
        .maybeSingle()
      if (!target) return fail(req, 'not_found', 404)

      const { data: warning, error } = await db
        .from('user_warnings')
        .insert({
          user_id: targetId,
          issued_by: ctx.userId,
          severity: ['notice', 'warning', 'final'].includes(body.severity ?? '')
            ? body.severity
            : 'notice',
          reason: reason.slice(0, 1000),
          related_report_id: body.reportId ?? null,
        })
        .select('id')
        .single()
      if (error) return fail(req, 'update_failed', 500, error.message)

      await audit(db, ctx.userId, 'user.warned', 'user', targetId, null,
        { warning_id: warning.id, severity: body.severity ?? 'notice', reason: reason.slice(0, 200) })
      return json(req, { ok: true, warning_id: warning.id })
    }

    default:
      return fail(req, 'bad_request', 400)
  }
})
