-- 0007_watch.sql — watch sessions, heartbeats, settle-at-30s, the sweep
--
-- THE CLIENT LIES. Everything here assumes it.
--
-- A heartbeat is a claim ("I watched 15 more seconds, I'm at 2:41"). The
-- server clamps every claim against wall-clock elapsed time and requires the
-- position to have moved forward. Without those two rules, a paused tab left
-- open overnight books eight hours of watch time — the single most common way
-- these dashboards end up lying — and a tampered client books whatever it
-- wants.

create table public.watch_sessions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               text not null,
  video_id              uuid not null references public.videos (id) on delete cascade,
  entitlement_id        uuid not null references public.video_entitlements (id) on delete cascade,

  started_at            timestamptz not null default now(),
  last_heartbeat_at     timestamptz not null default now(),
  ended_at              timestamptz,

  -- seconds_watched: validated engagement, feeds analytics + settlement.
  -- max_position_seconds: furthest point reached, feeds resume.
  -- DIFFERENT NUMBERS: seeking forward moves position, not watch time.
  seconds_watched       int not null default 0,
  max_position_seconds  int not null default 0,

  completed             boolean not null default false,
  settled               boolean not null default false,
  suspect               boolean not null default false,  -- clamped or rejected claims seen

  device                text,
  ip_hash               text
);

create index watch_sessions_user_idx on public.watch_sessions (user_id, started_at desc);
create index watch_sessions_entitlement_live_idx
  on public.watch_sessions (entitlement_id)
  where ended_at is null;
-- the sweep scans only unsettled sessions
create index watch_sessions_unsettled_idx
  on public.watch_sessions (last_heartbeat_at)
  where not settled and ended_at is null;

create table public.watch_history (
  user_id                text not null,
  video_id               uuid not null references public.videos (id) on delete cascade,
  last_position_seconds  int not null default 0,
  total_seconds_watched  bigint not null default 0,
  watch_count            int not null default 1,
  completed              boolean not null default false,
  first_watched_at       timestamptz not null default now(),
  last_watched_at        timestamptz not null default now(),
  primary key (user_id, video_id)
);

create index watch_history_recent_idx on public.watch_history (user_id, last_watched_at desc);

alter table public.watch_sessions enable row level security;
alter table public.watch_history  enable row level security;

create policy watch_sessions_select_own on public.watch_sessions
  for select using (user_id = public.clerk_user_id());
create policy watch_history_select_own on public.watch_history
  for select using (user_id = public.clerk_user_id());
-- All writes go through the functions below with the service role.

-- ── start_watch_session ───────────────────────────────────────────────────
-- Called by video-playback AFTER the entitlement check passes, BEFORE the
-- signed URL is returned. Enforces the concurrent-stream cap here, where the
-- session rows live, rather than in the Edge Function.
create or replace function public.start_watch_session(
  p_user_id text,
  p_video_id uuid,
  p_entitlement_id uuid,
  p_device text default null,
  p_ip_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitlement public.video_entitlements%rowtype;
  v_live        int;
  v_cap         int;
  v_session_id  uuid;
begin
  select * into v_entitlement
  from public.video_entitlements
  where id = p_entitlement_id
    and user_id = p_user_id
    and video_id = p_video_id
    and expires_at > now()
    and revoked_at is null;

  if not found then
    raise exception 'needs_unlock' using errcode = 'P0001';
  end if;

  -- A session with no heartbeat for 2 minutes is dead, whatever the client
  -- failed to tell us — browsers get killed, laptops get closed. Counting
  -- them against the cap would lock users out of their own entitlement.
  v_cap := public.setting_int('max_concurrent_streams', 2);
  select count(*) into v_live
  from public.watch_sessions
  where entitlement_id = p_entitlement_id
    and ended_at is null
    and last_heartbeat_at > now() - interval '2 minutes';

  if v_live >= v_cap then
    raise exception 'too_many_streams' using errcode = 'P0001';
  end if;

  insert into public.watch_sessions (user_id, video_id, entitlement_id, device, ip_hash)
  values (p_user_id, p_video_id, p_entitlement_id, p_device, p_ip_hash)
  returning id into v_session_id;

  -- watch_count increments per SESSION, not per heartbeat.
  insert into public.watch_history (user_id, video_id)
  values (p_user_id, p_video_id)
  on conflict (user_id, video_id) do update
    set watch_count = public.watch_history.watch_count + 1,
        last_watched_at = now();

  return jsonb_build_object('session_id', v_session_id);
end;
$$;

-- ── record_heartbeat ──────────────────────────────────────────────────────
create or replace function public.record_heartbeat(
  p_user_id text,
  p_session_id uuid,
  p_claimed_seconds int,       -- seconds watched since the LAST heartbeat
  p_position_seconds int,      -- current playhead position
  p_ended boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session      public.watch_sessions%rowtype;
  v_elapsed      numeric;
  v_credited     int;
  v_suspect      boolean := false;
  v_threshold    int;
  v_settled_now  boolean := false;
  v_video_len    int;
begin
  select * into v_session
  from public.watch_sessions
  where id = p_session_id and user_id = p_user_id
  for update;   -- serialize concurrent heartbeats for the same session

  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_session.ended_at is not null then
    -- A beacon raced a final heartbeat; nothing left to do. Not an error —
    -- pagehide + sendBeacon makes this ordering routine.
    return jsonb_build_object('ok', true, 'session_closed', true);
  end if;

  -- ── the two clamps ─────────────────────────────────────────────────────
  -- 1. A claim cannot exceed wall-clock time since the last heartbeat
  --    (+25% tolerance for timer jitter, playbackRate quirks and clock skew;
  --    a legitimate client sits well inside it).
  v_elapsed := extract(epoch from (now() - v_session.last_heartbeat_at));
  v_credited := least(
    greatest(coalesce(p_claimed_seconds, 0), 0),
    ceil(v_elapsed * 1.25)::int
  );
  if coalesce(p_claimed_seconds, 0) > ceil(v_elapsed * 1.25)::int then
    v_suspect := true;   -- clamped: remember that this session over-claimed
  end if;

  -- 2. Time only counts when the playhead MOVED FORWARD. A paused tab
  --    heartbeating with a frozen position books zero.
  if p_position_seconds is not null
     and p_position_seconds <= v_session.max_position_seconds
     and not p_ended then
    v_credited := 0;
  end if;

  -- A position beyond the video's length is a lie (or a duration bug); cap it.
  select duration_seconds into v_video_len from public.videos where id = v_session.video_id;
  if v_video_len is not null and p_position_seconds > v_video_len then
    p_position_seconds := v_video_len;
    v_suspect := true;
  end if;

  update public.watch_sessions
  set seconds_watched      = seconds_watched + v_credited,
      max_position_seconds = greatest(max_position_seconds, coalesce(p_position_seconds, 0)),
      last_heartbeat_at    = now(),
      suspect              = suspect or v_suspect,
      ended_at             = case when p_ended then now() else ended_at end,
      completed            = completed or (
        v_video_len is not null and v_video_len > 0
        and coalesce(p_position_seconds, 0) >= v_video_len * 0.9
      )
  where id = p_session_id
  returning * into v_session;

  -- ── settle-at-threshold ────────────────────────────────────────────────
  -- Once this session has v_threshold validated seconds, the hold behind a
  -- PURCHASE entitlement commits: the user has genuinely consumed the thing
  -- they paid for. Before that, bailing costs nothing (the sweep reverses).
  v_threshold := public.setting_int('settle_after_seconds', 30);

  if not v_session.settled and v_session.seconds_watched >= v_threshold then
    declare
      v_ledger uuid;
    begin
      select e.ledger_id into v_ledger
      from public.video_entitlements e
      where e.id = v_session.entitlement_id
        and e.source = 'purchase'
        and e.ledger_id is not null;

      if v_ledger is not null then
        begin
          perform public.settle_credit_hold(v_ledger, true);
          v_settled_now := true;
        exception when others then
          -- Already settled by an earlier session on the same entitlement.
          -- Fine: the charge exists exactly once, which is the invariant.
          null;
        end;
      end if;

      update public.watch_sessions set settled = true where id = p_session_id;
    end;
  end if;

  -- Keep history in step (resume position + lifetime totals).
  update public.watch_history
  set last_position_seconds = greatest(last_position_seconds, coalesce(p_position_seconds, 0)),
      total_seconds_watched = total_seconds_watched + v_credited,
      completed             = completed or v_session.completed,
      last_watched_at       = now()
  where user_id = p_user_id and video_id = v_session.video_id;

  -- Denormalized video totals (the admin dashboard reads these, not SUM()s
  -- over sessions — CLAUDE.md trap #13).
  if v_credited > 0 then
    update public.videos
    set total_watch_seconds = total_watch_seconds + v_credited
    where id = v_session.video_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'credited', v_credited,
    'clamped', v_suspect,
    'seconds_watched', v_session.seconds_watched,
    'settled', v_session.settled or v_settled_now
  );
end;
$$;

-- ── sweep_stale_holds ─────────────────────────────────────────────────────
-- The other half of settle-at-30s: a user who clicked, watched 8 seconds and
-- never came back gets their credit back. Runs nightly via pg_cron; also
-- closes sessions whose client vanished without a final beacon.
create or replace function public.sweep_stale_holds()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_age_hours   int;
  v_threshold   int;
  v_reversed    int := 0;
  v_closed      int := 0;
  v_row         record;
begin
  v_age_hours := public.setting_int('hold_sweep_after_hours', 24);
  v_threshold := public.setting_int('settle_after_seconds', 30);

  -- Close sessions that stopped heartbeating >2h ago and never said goodbye.
  update public.watch_sessions
  set ended_at = last_heartbeat_at
  where ended_at is null
    and last_heartbeat_at < now() - interval '2 hours';
  get diagnostics v_closed = row_count;

  -- Reverse holds older than the window whose entitlement never crossed the
  -- settle threshold across ALL its sessions (device-switching must not get
  -- someone refunded for a video they actually watched in two halves).
  for v_row in
    select l.id as ledger_id, e.id as entitlement_id
    from public.credit_ledger l
    join public.video_entitlements e on e.ledger_id = l.id
    where l.status = 'pending'
      and l.reason = 'watch_debit'
      and l.created_at < now() - make_interval(hours => v_age_hours)
      and coalesce((
        select sum(ws.seconds_watched)
        from public.watch_sessions ws
        where ws.entitlement_id = e.id
      ), 0) < v_threshold
  loop
    begin
      perform public.settle_credit_hold(v_row.ledger_id, false);
      update public.video_entitlements
      set revoked_at = now(), revoke_reason = 'hold_swept_unwatched'
      where id = v_row.entitlement_id;
      v_reversed := v_reversed + 1;
    exception when others then
      null;  -- settled in the window between select and settle; skip
    end;
  end loop;

  return jsonb_build_object('sessions_closed', v_closed, 'holds_reversed', v_reversed);
end;
$$;

-- ── LOCK DOWN (CLAUDE.md trap #7) ─────────────────────────────────────────
revoke execute on function
  public.start_watch_session(text, uuid, uuid, text, text),
  public.record_heartbeat(text, uuid, int, int, boolean),
  public.sweep_stale_holds()
from public, anon, authenticated;

grant execute on function
  public.start_watch_session(text, uuid, uuid, text, text),
  public.record_heartbeat(text, uuid, int, int, boolean),
  public.sweep_stale_holds()
to service_role;

-- ── nightly sweep ─────────────────────────────────────────────────────────
-- pg_cron is an EXTENSION on Supabase, not a default: create it first. The
-- exception guard catches any failure class (missing schema is 3F000
-- invalid_schema_name, not undefined_table — learned by hitting it), because a
-- missing cron job degrades gracefully but a failed migration blocks the line.
create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sweep-stale-holds') then
    perform cron.unschedule('sweep-stale-holds');
  end if;
  perform cron.schedule('sweep-stale-holds', '17 3 * * *', 'select public.sweep_stale_holds()');
exception when others then
  raise notice 'pg_cron unavailable (%); schedule sweep_stale_holds() externally', sqlerrm;
end $$;
