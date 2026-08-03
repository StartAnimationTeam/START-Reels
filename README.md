# START Video Library

An in-house video streaming platform by **START LANDS Inc.**

Browse and stream a curated catalogue. Free titles cost nothing; premium and
exclusive titles unlock with credits. Creators upload, moderators review,
administrators run it all from a dashboard.

---

## The one idea that explains the schema

**Watching does not charge. Unlocking does.**

An unlock writes an entitlement row granting access for 48 hours. Inside that
window, rewatching, seeking, reloading, switching devices and resuming tomorrow
are all free â€” because the entitlement already exists. Idempotency comes from a
row existing, not from application logic remembering.

Credits are **held** on unlock and only **committed** after 30 validated seconds
of watching. Click, watch eight seconds, close the tab, and a nightly sweep
gives the credit back.

## Stack

| | |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, Tailwind v4, on Vercel |
| Auth | Clerk â€” public signup; roles in a `user_roles` table we control |
| Backend | Supabase: Postgres, Deno Edge Functions, numbered migrations |
| Video | Bunny.net Stream â€” HLS with path-scoped token authentication |
| Player | hls.js, with the native path on Safari |
| Search | Postgres full-text search (`tsvector` + GIN) |

## Running it

You need a Clerk app, a Supabase project and a Bunny.net Stream library. None is
optional â€” there is no offline mode, because every meaningful path
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
| **0** | Foundations â€” auth, identity + ledger schema, RLS, webhook | **done** â€” 40/40 checks green against the live project |
| 1 | Ingest & catalogue â€” Bunny upload, transcode, thumbnails | **done** â€” real clip through the real pipeline, 18/18 (`test-ingest-live`); token auth verified down to the segment level |
| 2 | Playback & credits â€” entitlements, signed URLs, heartbeats | **done** â€” 74 checks green (entitlements 29, watch-time 25, HTTP paywall 20) plus the loop-closer: a real unlock returns a URL that actually streams |
| 3 | Browse - search, rails, recommendations, favorites | **done** - FTS + prefix fallback, SQL recommender, scroll-snap rails, optimistic favorites |
| 4 | Profile & wallet | **done** - daily rewards (raced-claim safe), promo codes (no-oracle errors), history with resume, settings + avatars |
| 5 | Creator flow | not started |
| 6 | Admin & moderation | **first pass done** - upload UI, video + user management, audited; reports/promos/settings next |
| 7 | Analytics | not started |
| 8 | Hardening & launch | not started |

## Tests

```bash
npm run verify     # all four suites, ~1 min
```

| | |
|---|---|
| `db:verify` | Schema shape: RLS on every table, `security_invoker` on every view, no user-id-taking `SECURITY DEFINER` function callable by a public role, audit log append-only, and live ledger semantics (hold reduces balance, reversal restores it, overspend raises) |
| `test:rls` | **The Phase 0 gate.** Two real Clerk users, real session tokens: A cannot read B's ledger, balance or profile, and neither can escalate a role or mint credits |
| `test:webhook` | Signs payloads the way svix does and posts them at the deployed function â€” forged signatures rejected, and a replay does not double-grant |
| `test:signup` | The acceptance test: creates a real Clerk user and waits for the profile and credits to appear. Proves *delivery*, which the others cannot |

**Why `test:rls` is a gate and not just a test.** Under a third-party JWT
issuer, **RLS returns an empty array rather than an error** when misconfigured.
A broken auth chain and a brand-new account are indistinguishable. It caught a
real leak on its first run â€” see `0004_view_security_invoker.sql`. Do not build
past Phase 0 without it green.

**Why `test:webhook` and `test:signup` are separate.** One proves the handler is
correct; the other proves Clerk is actually configured to call it. A perfect
handler behind an unregistered endpoint produces a user who exists in Clerk,
cannot be found in Postgres, and has no credits â€” while nothing errors anywhere.

The credential-free suites (`test-credits`, `test-entitlements`,
`test-watchtime`) arrive with Phase 2 and run in CI.

**Before any deploy:** `npx tsc --noEmit` and `npm run build` in `web/`, plus
`deno check` on the functions. CI runs all three, and also checks that migration
numbers don't collide and that no `SECURITY DEFINER` function was left
world-executable.

## Where to read next

| | |
|---|---|
| **[CLAUDE.md](CLAUDE.md)** | How it works and why, plus 18 traps. Read before changing anything â€” most of it exists because something broke |
| `supabase/migrations/` | Numbered, sequential. Never edit one already applied |

## A few decisions worth knowing up front

Each looks like an omission until you know the reason.

**One credit type, not six.** The sibling project shipped six and four were
unspendable, so users saw a balance they could never spend. If a second type is
ever genuinely needed, it needs a spend path shipped in the same PR.

**No payments.** Credits are granted â€” signup, daily reward, promo code, admin
grant. This is an in-house platform; credits allocate access, they aren't
revenue. The ledger reserves `top_up` and `payment` reasons so Stripe is one
function and one webhook later, not a migration.

**The absence of a row is "User".** `user_roles` has no `user` value. A default
state with its own row is a second source of truth for the same fact.

**Signed URLs are not DRM.** Within its TTL, whoever holds the URL can play.
Short TTL, per-request minting behind an entitlement check, and a concurrent
session cap are the correct answer at this scale â€” and they are not the same
thing as protection. Said out loud so nobody later assumes otherwise.

**The audit log is append-only.** `UPDATE` and `DELETE` are revoked from every
role, `service_role` included. A gap in an audit trail is honest; a rewritten
one is not.

---

Â© START LANDS Inc.
