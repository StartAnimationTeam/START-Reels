import { clerkMiddleware } from '@clerk/nextjs/server'

/**
 * Clerk session context. Deliberately does NOT guard routes.
 *
 * ── Why there is no route matcher here ─────────────────────────────────────
 * Clerk deprecated `createRouteMatcher` for a reason worth repeating: proxy
 * path matching can diverge from how Next.js actually routes a request, so a
 * protected resource can stay reachable while the matcher looks correct.
 * Authorization belongs next to the data it protects, not in a path pattern
 * two layers away.
 *
 * So this file only establishes the session. Every protected surface calls
 * `requireUser()` or `requireRole()` from `@/lib/auth` itself. That is also the
 * only way role checks can work at all here — a Clerk session token says who
 * you are, and `user_roles` says what you may do.
 *
 * ── Why the file is named proxy.ts ─────────────────────────────────────────
 * Next.js 16 renamed the `middleware.ts` convention to `proxy.ts` and silently
 * ignores the old filename.
 *
 * ── Why the export is named, not default ───────────────────────────────────
 * Next 16 resolves the Node-runtime proxy as:
 *     adapterFn = module.default || module
 *     adapterFn({ handler: module.proxy || module.middleware || module, ... })
 * `default` is expected to be Next's own ADAPTER; the handler is expected at
 * `proxy`. Default-exporting the handler makes every request fail with
 * "TypeError: adapterFn is not a function" — while `next build` still succeeds
 * and prints "ƒ Proxy (Middleware)", so nothing warns you.
 */
export const proxy = clerkMiddleware()

export const config = {
  matcher: [
    // Everything except Next internals and static files, unless a search param
    // is present (so a static asset URL carrying state still hits the proxy).
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes.
    '/(api|trpc)(.*)',
  ],
}
