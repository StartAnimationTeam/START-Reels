/**
 * CORS. Written by hand on purpose.
 *
 * Supabase Edge Functions do not add CORS headers for you, and any function
 * that does its own Clerk verification must also set `verify_jwt = false` in
 * config.toml — otherwise the platform rejects the request with its own 401
 * before your handler ever runs, and the failure looks like a bug in your auth
 * code rather than a config line. (CLAUDE.md trap #9)
 *
 * ALLOWED_ORIGIN is never `*` in production. A wildcard here plus credentials
 * is how a signed playback token ends up readable by any page on the internet.
 */

const RAW_ORIGINS = Deno.env.get('ALLOWED_ORIGIN') ?? 'http://localhost:3000'
const ALLOWED = RAW_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  // Echo the origin only when it is on the list. Echoing an arbitrary origin
  // back is functionally identical to `*` while looking stricter.
  const allow = ALLOWED.includes(origin) ? origin : ALLOWED[0] ?? ''

  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export function handlePreflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  return new Response(null, { status: 204, headers: corsHeaders(req) })
}

export function json(
  req: Request,
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', ...extra },
  })
}

/**
 * Error responses carry a stable machine `code`, never a raw message.
 * `web/src/lib/labels.ts` is the only place those codes become English —
 * so a DB exception string can never reach a user's screen.
 */
export function fail(req: Request, code: string, status = 400, detail?: string): Response {
  return json(req, { error: code, ...(detail ? { detail } : {}) }, status)
}
