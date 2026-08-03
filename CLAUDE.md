# START Video Library — Project Guide for AI Agents

Orients an AI coding agent (or a human) picking up this project cold. **Read
before changing anything.** Most of §Traps exists because something broke — here
or in the sibling project.

## What this is

An in-house Netflix-style video streaming platform by **START LANDS Inc.**
Users browse and stream a curated library; credits gate premium content;
creators upload; moderators review; administrators run it all from a dashboard.

The approved build plan is `C:\Users\Admin\.claude\plans\plan-and-have-a-mossy-globe.md`.
Project memory (goal, stack decisions, credit model) lives in
`C:\Users\Admin\.claude\projects\c--Users-Admin-Claude-Project-START-Video-Library\memory\`.

**Sibling project:** `c:\Users\Admin\Claude Project\START AI Studio` is the
house-style reference, maintained by the same team. Port its credit ledger and
RLS patterns. Do **not** repeat its five documented mistakes (see below).

## Stack

| | |
|---|---|
| Frontend | Next.js 16 (App Router), React, Tailwind v4, deployed on Vercel |
| Auth | Clerk — public signup, roles in a `user_roles` table we control |
| Backend | Supabase: Postgres, Deno Edge Functions, numbered migrations |
| Video | Bunny.net Stream — HLS, token-authenticated playback |
| Player | hls.js + native-HLS fallback (Safari) |
| Search | Postgres FTS (`tsvector` + GIN) |

## The one idea that explains the schema

**Watching does not charge. Unlocking does.**

An unlock writes a `video_entitlements` row granting access until `expires_at`
(default 48h). Within that window, rewatching, seeking, reloading, switching
devices and resuming tomorrow are all free — because the entitlement already
exists. *Idempotency comes from a row existing, not from application logic
remembering.*

Credits are **held** on unlock and only **committed** after 30 validated
seconds of watching. Bail at 8 seconds and a nightly sweep reverses the hold.
This is why `reserve_credits` / `settle_credit_hold` exist rather than a plain
`UPDATE balance`.

## Repo layout

```
scripts/           node scripts; test-*.mjs import the real Deno modules
supabase/
  migrations/      numbered, sequential. NEVER edit one already applied
  functions/
    _shared/       plain modules, NO Deno.serve() — imported by the functions
      bunny.ts     ★ the ONLY file that knows Bunny exists
web/src/
  proxy.ts         Clerk guard — NOT middleware.ts (Next 16 renamed it)
  app/             App Router pages
  components/ui/   Radix primitives, brand-styled in-repo
  lib/labels.ts    ★ nothing raw reaches the screen
```

## Conventions

- **All user id columns are `text`**, holding a Clerk `user_2…` id. Never
  `uuid references auth.users(id)` — that breaks the entire schema.
- **`auth.uid()` is null here.** Use `auth.jwt()->>'sub'` in every RLS policy.
- **RLS on every table.** A table with *no policies* is service-role-only by
  design — that is a decision, not an oversight.
- **Reads** go straight from Server Components through the RLS-scoped client.
  **Anything that moves value or state** goes through an Edge Function with the
  service role. Split the trust boundary; don't route browse through functions.
- **Enforcement lives in the DB function, not the caller.** Several callers
  reach `unlock_video`; a rule in one HTTP handler is a rule the others skip.
- Migrations are numbered and sequential. Adding a column means a new file.

## Traps

Each of these has cost someone real time.

1. **Bunny bills per GB, not per minute.** A 4 GB master of a 10-minute video
   costs 4 GB plus every rendition. Public signup means strangers upload. So:
   cap upload size *and* duration server-side before minting the upload token,
   trim the encoding ladder to 360/720/1080, disable "keep original file", and
   keep geo-replication to one or two regions. Skip these and the bill is a
   function of what strangers choose to upload.
2. **Sign the path, not just the manifest.** Use Bunny's `token_path` so one
   token authorizes the `.m3u8` *and* every segment beneath it. Signing only
   the manifest leaves segments openly fetchable forever, which makes the
   entire credit paywall decorative.
3. **Bunny webhooks are not reliably signed.** On receipt, re-fetch the video
   by GUID from the Bunny API. Never trust the payload.
4. **HLS in Safari.** Safari plays HLS natively from `<video src>`; Chrome and
   Firefox need MSE via hls.js. Feature-detect. Native HLS ignores hls.js-level
   ABR config, so a custom quality selector must be detected, not assumed. iOS
   needs `playsInline` or it force-fullscreens, and won't autoplay with sound.
5. **Video bytes never pass through Vercel or Supabase.** Vercel serverless
   request bodies cap at ~4.5 MB — a 2 GB upload through a Route Handler is
   impossible, not merely slow. Browser → Bunny on a direct-upload token,
   always, via TUS so a dropped connection resumes.
6. **RLS with a third-party JWT issuer fails *silently*.** If the Clerk↔Supabase
   integration is off, or the Supabase client is built without the
   `accessToken` callback, reads return **empty** rather than erroring. It looks
   like "no data" and it is "auth is broken." `scripts/test-rls.mjs` exists to
   catch exactly this and gates Phase 0.
7. **`SECURITY DEFINER` functions are world-executable until revoked.**
   Postgres grants EXECUTE to PUBLIC on create, and PostgREST exposes every
   public-schema function at `/rest/v1/rpc/`. `unlock_video`, `reserve_credits`,
   `settle_credit_hold` and `record_heartbeat` all take a `p_user_id`, so
   without an explicit `revoke execute … from public, anon, authenticated`
   anyone holding the publishable key — which ships in the browser bundle —
   can unlock any video on any account. **A `CREATE OR REPLACE` that changes
   the signature re-grants it**, so repeat the revoke in that same migration.
8. **Wrap RLS helper predicates**: `(select has_role('administrator'))`, not
   `has_role('administrator')`. Unwrapped, Postgres re-evaluates per row and the
   admin tables time out.
8b. **A VIEW bypasses RLS unless you say otherwise.** A Postgres view runs with
   the privileges of its *owner*, and the owner (`postgres`) bypasses RLS — so a
   view over an RLS-protected table exposes every row, no matter how correct the
   table's policy is. `credit_balances` leaked every user's balance exactly this
   way; `scripts/test-rls.mjs` caught it on its first run and
   `0004_view_security_invoker.sql` fixed it.

   **Every view over a protected table must `set (security_invoker = on)`.**
   This is invisible to inspection: the table looks locked down, the policy
   reads correctly, and direct queries on the table behave. Only a query
   *through the view, as a real user* reveals it. `scripts/db-verify.mjs`
   asserts it for all views so a new one cannot reintroduce the hole.
9. **`ALLOWED_ORIGIN` is never `*`.** Edge Functions need manual CORS headers
   and `verify_jwt = false` in `config.toml` when they do their own Clerk
   verification — otherwise the platform 401s before your code runs.
10. **Webhooks are at-least-once.** Claim a row in `processed_webhook_events`
    *before* doing the work; answer **200** on duplicates (a non-2xx makes the
    sender retry, which on a replay loops forever); release the claim if the
    work then fails. A retry once silently double-granted credits in AI Studio
    and the balance view quietly doubled.
11. **Client heartbeats lie.** Clamp every increment to wall-clock elapsed since
    `last_heartbeat_at`. Require a *forward* position delta, or a paused tab left
    open overnight books eight hours of watch time — the single most common way
    these dashboards end up lying. `max_position_seconds` (resume) and
    `seconds_watched` (analytics) are different numbers.
12. **Next.js 16 renamed `middleware.ts` → `proxy.ts`.** The old filename is
    silently ignored, not an error.
13. **Never select a column you only need for a handful of rows.** AI Studio's
    dashboard died on statement timeout after weeks of working fine, because the
    cost grew with the data. Aggregate in SQL. Never select `provider_asset_id`
    into a list — it is the thing signed URLs exist to protect.
14. **Deleting a paid video must revoke, refund and audit.** Otherwise a
    moderator silently destroys content people paid for.
15. **A permission boundary must say so.** Rendering nothing where a control
    belongs reads as a broken page — that is how AI Studio's missing approval
    buttons were first reported. Route everything through `lib/labels.ts`.
16. **Signed URLs are not DRM.** Within its TTL, whoever holds the URL can play.
    Short TTL + per-request minting behind an entitlement check + a concurrent
    session cap is the correct MVP answer. If "must not be shareable at all"
    ever becomes a requirement, that is Widevine/FairPlay and a separate
    project. Do not let anyone assume the signature already provides it.
17. **Daily-reward dates are computed server-side** in
    `platform_settings.platform_timezone` — never UTC-by-accident, never the
    browser clock, or users near midnight double-claim or feel robbed.
18. **The UI shows `available_balance`** (committed + pending holds), never
    `committed_balance`, or a user with open holds sees credits they can't spend.

## What the sibling project got wrong — do not repeat

- **Six credit types, four unspendable.** Users saw a balance they could never
  spend. This project ships exactly **one** credit type.
- **RLS never actually confirmed.** Their `supabase/README.md` admits the
  Clerk↔Supabase integration "has never been confirmed," so every function
  falls back to the service role and client-side RLS is dead weight.
- **`SECURITY DEFINER` left world-executable** — shipped exploitable for months.
- **A webhook retry double-granted credits.**
- **No CI at all.** Added here at Phase 0, when it is cheap.

## Environment

`web/.env.local` (browser + Next server), `supabase/.env` (Edge Function
secrets), `.env` (Node scripts + CLI). All three are gitignored; `.example`
copies are committed.

**`SUPABASE_ACCESS_TOKEN` (`sbp_…`) and `SUPABASE_SERVICE_ROLE_KEY`
(`sb_secret_…`) are not interchangeable** — one deploys, the other reads tables.
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected into Edge
Functions; do not set them yourself, the platform rejects secret names starting
with `SUPABASE_`.

`CLERK_ISSUER` is derivable from the publishable key: base64-decode the segment
after `pk_test_` / `pk_live_` and drop the trailing `$`.

## Before any deploy

```bash
cd web && npx tsc --noEmit && npm run build
deno check supabase/functions/**/*.ts
```

This has caught real errors every time skipping it would have shipped one.

---
© START LANDS Inc.
