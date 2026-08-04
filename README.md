# START Reels

An AI-powered short-form video streaming platform by **START LANDS Inc.** —
vertical short dramas and mini-series.

Shows are **series of short episodes**: the first episodes are free, later
ones unlock with coins. A vertical For You feed, tabbed home with rankings,
7-day check-in rewards and a members-only shelf round out the surface.
Creators upload, moderators review, administrators run it all from a
dashboard.

*Pivoted 2026-08-04 from the original Netflix-style "START Video Library"
(migrations 0017–0021). Every pre-pivot video became a 1-episode series at an
identical resolved price; the MVP survives as branch `mvp` / tag
`v1.0.0-mvp`.*

---

## The one idea that explains the schema

**Watching does not charge. Unlocking does.**

An unlock writes an entitlement row. Since the pivot the window is effectively
permanent (`entitlement_window_hours = 87600`): once an episode is yours,
rewatching, seeking, reloading, switching devices and resuming tomorrow are
all free — because the entitlement already exists. Idempotency comes from a
row existing, not from application logic remembering.

Pricing lives on the **series** (`free_episode_count`, `episode_credit_cost`);
episodes inside the free window write no ledger row at all. Coins ("credits"
everywhere below the labels layer) are **held** on unlock and only
**committed** after 10 validated seconds of watching — a third of a minute
episode, not a third of a movie. Bail early and a nightly sweep gives the
coins back.

## Stack

| | |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, Tailwind v4, on Vercel |
| Auth | Clerk — public signup; roles in a `user_roles` table we control |
| Backend | Supabase: Postgres, Deno Edge Functions, numbered migrations |
| Video | Bunny.net Stream — HLS with path-scoped token authentication |
| Player | hls.js, with the native path on Safari |
| Search | Postgres full-text search (`tsvector` + GIN) |

## Running it

You need a Clerk app, a Supabase project and a Bunny.net Stream library. None is
optional — there is no offline mode, because every meaningful path
authenticates and most spend credits.

```bash
cd web
npm install
cp .env.local.example .env.local     # Clerk + Supabase required
npm run dev
```

Then apply the migrations and deploy the functions:

```bash
npm install                                   # repo root, for the CLI + scripts
npx supabase link --project-ref ioulkocgnprfyofmvnbd
npx supabase db push
npx supabase secrets set --env-file supabase/.env
npx supabase functions deploy clerk-webhook
```

**Node 22 or later.** Next 16 itself runs on 20.9+, but `@supabase/supabase-js`
warns on 20 and the `scripts/test-*.mjs` suites need `--experimental-strip-types`
(Node 22.6+) to import the Edge Function modules directly.

A fresh clone cannot deploy or live-test until an owner supplies credentials. It
can read, reason about and typecheck the code.

## Build status

| Phase | | |
|---|---|---|
| **0** | Foundations — auth, identity + ledger schema, RLS, webhook | **done** — 40/40 checks green against the live project |
| 1 | Ingest & catalogue — Bunny upload, transcode, thumbnails | **done** — real clip through the real pipeline, 18/18 (`test-ingest-live`); token auth verified down to the segment level |
| 2 | Playback & credits — entitlements, signed URLs, heartbeats | **done** — 74 checks green (entitlements 29, watch-time 25, HTTP paywall 20) plus the loop-closer: a real unlock returns a URL that actually streams |
| 3 | Browse - search, rails, recommendations, favorites | **done** - FTS + prefix fallback, SQL recommender, scroll-snap rails, optimistic favorites |
| 4 | Profile & wallet | **done** - daily rewards (raced-claim safe), promo codes (no-oracle errors), history with resume, settings + avatars |
| 5 | Creator flow | **done** - apply via RLS, staff review queue, creator uploads land in moderation |
| 6 | Admin & moderation | **done** - upload, video/user/creator management, reports queue, warnings, promo admin, settings, audit viewer, maintenance mode |
| 7 | Analytics | **done** - nightly rollups (idempotent), hourly trending MV, Bunny audit columns, validated-palette dashboards |
| 8 | Hardening & launch | **code done** - pg rate limits (race-tested), security headers, 12-suite verify chain; owner runbook items remain |

**The 2026-08 series pivot** (after the v1.0.0-mvp tag), in six shipped
phases:

| Pivot phase | | |
|---|---|---|
| 1 | Series schema + backfill (0017, 0018) | series/episodes model, follows, resume view; every video became a 1-episode series |
| 2 | Economy (0019, 0020) | series pricing in `unlock_video`, ~permanent unlocks, 10s settle, 7-day check-in streaks |
| 3 | Discovery + management (0021) | series trending MV, series recommender, `series-manage` function, episode uploads |
| 4 | Restyle + shell | pink/red brand, bottom tabs, home tabs (Popular/New/Rankings/Categories), series detail + episode grid |
| 5 | Watch + unlock UX | vertical 9:16 player, auto-advance, UnlockDialog, profile hub (`/me` → `/profile`) |
| 6 | Feed + rewards + member shell | swipeable For You feed (mint-cached, ≤1 prefetch), check-in ladder, membership preview |

## Tests

```bash
npm run verify     # all four suites, ~1 min
```

| | |
|---|---|
| `db:verify` | Schema shape: RLS on every table, `security_invoker` on every view, no user-id-taking `SECURITY DEFINER` function callable by a public role, audit log append-only, and live ledger semantics (hold reduces balance, reversal restores it, overspend raises) |
| `test:rls` | **The Phase 0 gate.** Two real Clerk users, real session tokens: A cannot read B's ledger, balance or profile, and neither can escalate a role or mint credits |
| `test:webhook` | Signs payloads the way svix does and posts them at the deployed function — forged signatures rejected, and a replay does not double-grant |
| `test:signup` | The acceptance test: creates a real Clerk user and waits for the profile and credits to appear. Proves *delivery*, which the others cannot |

**Why `test:rls` is a gate and not just a test.** Under a third-party JWT
issuer, **RLS returns an empty array rather than an error** when misconfigured.
A broken auth chain and a brand-new account are indistinguishable. It caught a
real leak on its first run — see `0004_view_security_invoker.sql`. Do not build
past Phase 0 without it green.

**Why `test:webhook` and `test:signup` are separate.** One proves the handler is
correct; the other proves Clerk is actually configured to call it. A perfect
handler behind an unregistered endpoint produces a user who exists in Clerk,
cannot be found in Postgres, and has no credits — while nothing errors anywhere.

The credential-free suites (`test-credits`, `test-entitlements`,
`test-watchtime`) arrive with Phase 2 and run in CI.

**Before any deploy:** `npx tsc --noEmit` and `npm run build` in `web/`, plus
`deno check` on the functions. CI runs all three, and also checks that migration
numbers don't collide and that no `SECURITY DEFINER` function was left
world-executable.

## Launch runbook (the owner's checklist)

Everything below needs account access only the owner has. The code side is
done; each item unlocks one production property.

1. **Vercel — DONE 2026-08-03.** Live at https://start-reels.vercel.app (team start-lands-inc, project start-reels, CLI-deployed). ALLOWED_ORIGIN includes the prod domains. Redeploy: `npx vercel deploy --prod` in web/ with VERCEL_TOKEN from .env. Original step, kept for a custom domain later: vercel.com → Add New Project →
   import `StartAnimationTeam/START-Reels`, root directory `web/`. **Pro
   plan** (Hobby blocks git deploys when the commit author isn't the account
   owner). Add the env vars from `web/.env.local.example` with real values.
   After the first deploy, set `ALLOWED_ORIGIN` in the Supabase function
   secrets to the production URL (`supabase secrets set ALLOWED_ORIGIN=https://…`)
   — never `*` — and add the domain to Clerk (production instance) and to
   Bunny's allowed referrers.
2. **CI secrets (makes the build job green).** GitHub repo → Settings →
   Secrets and variables → Actions: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable
   values; secrecy isn't the point, rotation-in-one-place is).
3. **Clerk production instance.** The `pk_test_`/`sk_test_` keys are the dev
   instance. Before real users: create the production instance (Clerk
   dashboard), re-run the Phase 0 dashboard config on it (email+password,
   verification, bot protection, Supabase third-party auth), point the
   webhook at the same function URL, and swap the four Clerk values.
4. **Bunny payment method** before the trial's 14 days lapse, or all video
   serving stops. Set a billing alert (~$10/mo) at the same time.
5. **Sentry** (error visibility — optional, recommended):
   `npx @sentry/wizard@latest -i nextjs` in `web/` with a free-tier DSN.
6. **Resend** (product email — optional until notifications matter): API key
   plus SPF/DKIM DNS records on the sending domain; DNS propagation is the
   slow part, start early.
7. **Upstash** (only at real scale): the rate limiter is Postgres-based by
   design and right-sized for thousands of users; swap the `check_rate_limit`
   call sites to Upstash when the counter table itself becomes hot.

## Where to read next

| | |
|---|---|
| **[CLAUDE.md](CLAUDE.md)** | How it works and why, plus 18 traps. Read before changing anything — most of it exists because something broke |
| `supabase/migrations/` | Numbered, sequential. Never edit one already applied |

## A few decisions worth knowing up front

Each looks like an omission until you know the reason.

**One credit type, not six.** The sibling project shipped six and four were
unspendable, so users saw a balance they could never spend. If a second type is
ever genuinely needed, it needs a spend path shipped in the same PR.

**No payments.** Credits are granted — signup, daily reward, promo code, admin
grant. This is an in-house platform; credits allocate access, they aren't
revenue. The ledger reserves `top_up` and `payment` reasons so Stripe is one
function and one webhook later, not a migration.

**The absence of a row is "User".** `user_roles` has no `user` value. A default
state with its own row is a second source of truth for the same fact.

**Signed URLs are not DRM.** Within its TTL, whoever holds the URL can play.
Short TTL, per-request minting behind an entitlement check, and a concurrent
session cap are the correct answer at this scale — and they are not the same
thing as protection. Said out loud so nobody later assumes otherwise.

**The audit log is append-only.** `UPDATE` and `DELETE` are revoked from every
role, `service_role` included. A gap in an audit trail is honest; a rewritten
one is not.

---

© START LANDS Inc.
