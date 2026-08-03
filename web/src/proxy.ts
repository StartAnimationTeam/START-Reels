import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

/**
 * Clerk auth guard.
 *
 * This file is `proxy.ts`, NOT `middleware.ts` — Next.js 16 renamed the
 * convention and silently ignores the old filename. Clerk 7.6+ knows about the
 * rename (`isNext16OrHigher ? ['middleware', 'proxy']`), so `clerkMiddleware`
 * is still the right export to call from it.
 *
 * Default posture is PUBLIC. This is a video library with public signup: the
 * catalog has to be browsable by a logged-out visitor or there is nothing to
 * sign up for. Playback is not gated here — it is gated by the entitlement
 * check inside the `video-playback` Edge Function, because a route guard
 * cannot know whether someone has paid.
 */

const isProtectedRoute = createRouteMatcher([
  '/me(.*)',
  '/creator(.*)',
  '/admin(.*)',
])

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    // Redirects anonymous visitors to /sign-in. Role checks are NOT done here:
    // /admin and /creator verify roles server-side against `user_roles`, since
    // a Clerk session token says who you are, not what you may do.
    await auth.protect()
  }
})

export const config = {
  matcher: [
    // Everything except Next internals and static files, unless a search param
    // is present (so a static asset URL carrying state still hits the proxy).
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes.
    '/(api|trpc)(.*)',
  ],
}
