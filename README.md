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
are all free — because the entitlement already exists. Idempotency comes from a
row existing, not from application logic remembering.

Credits are **held** on unlock and only **committed** after 30 validated seconds
of watching. Click, watch eight seconds, close the tab, and a nightly sweep
gives the credit back.

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
| **0** | Foundations — auth, identity + ledger schema, RLS, webhook | **in progress** |
| 1 | Ingest & catalogue — Bunny upload, transcode, thumbnails | not started |
| 2 | Playback & credits — entitlements, signed URLs, heartbeats | not started |
| 3 | Browse — search, rails, recommendations, favorites | not started |
| 4 | Profile & wallet | not started |
| 5 | Creator flow | not started |
| 6 | Admin & moderation | not started |
| 7 | Analytics | not started |
| 8 | Hardening & launch | not started |

## Tests

**`scripts/test-rls.mjs` is the Phase 0 gate.** It creates two real Clerk users,
mints real session tokens, and asserts that user A cannot read user B's ledger,
balance or profile — and that neither can escalate their own role or mint their
own credits.

```bash
node scripts/test-rls.mjs
```

It exists because of a specific failure mode: under a third-party JWT issuer,
**RLS returns an empty array rather than an error** when the integration is
misconfigured. A broken auth chain and a brand-new account look identical. The
sibling project never resolved this and its client-side RLS is decorative as a
result. Do not build past Phase 0 until this is green.

The credential-free suites (`test-credits`, `test-entitlements`,
`test-watchtime`) arrive with Phase 2 and run in CI.

**Before any deploy:** `npx tsc --noEmit` and `npm run build` in `web/`, plus
`deno check` on the functions. CI runs all three, and also checks that migration
numbers don't collide and that no `SECURITY DEFINER` function was left
world-executable.

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
