#!/usr/bin/env node
/**
 * Seed demo catalog content so browse → watch → unlock is clickable.
 *
 * Videos are seeded WITHOUT provider_asset_id — playback stops at
 * `video_not_ready` (409) until real uploads exist in Phase 1's ingest flow.
 * The unlock/credit path in front of it is fully live, which is the point:
 * you can spend and get refunded real credits against demo rows.
 *
 * Idempotent: re-running updates the same slugs rather than duplicating.
 *
 * Usage:  node scripts/seed-catalog.mjs
 */

import { loadEnv, sql } from './_db.mjs'

loadEnv()

const CREATOR = 'seed_catalog_creator'

const CATEGORIES = [
  { slug: 'company', name: 'Company', sort: 10 },
  { slug: 'training', name: 'Training', sort: 20 },
  { slug: 'product', name: 'Product', sort: 30 },
  { slug: 'events', name: 'Events', sort: 40 },
]

const VIDEOS = [
  { slug: 'welcome-to-start', title: 'Welcome to START LANDS', tier: 'free', cost: 0, dur: 272, cat: 'company', featured: 1,
    desc: 'An introduction to the company, the teams, and how we work.' },
  { slug: 'studio-tour', title: 'Studio Tour', tier: 'free', cost: 0, dur: 418, cat: 'company', featured: 2,
    desc: 'A walk through the studio floors, from concept art to final render.' },
  { slug: 'onboarding-day-one', title: 'Onboarding: Day One', tier: 'free', cost: 0, dur: 655, cat: 'training',
    desc: 'Accounts, tools and who to ask - everything a new hire needs before lunch.' },
  { slug: 'animation-pipeline-deep-dive', title: 'Animation Pipeline Deep Dive', tier: 'premium', cost: 1, dur: 1841, cat: 'training',
    desc: 'From storyboard to composite: the full production pipeline, stage by stage.' },
  { slug: 'rigging-masterclass', title: 'Rigging Masterclass', tier: 'premium', cost: 1, dur: 2710, cat: 'training',
    desc: 'Senior rigging artists break down a production character rig.' },
  { slug: 'product-roadmap-2026', title: 'Product Roadmap 2026', tier: 'premium', cost: 1, dur: 1205, cat: 'product',
    desc: 'Where the product lines are going this year, and why.' },
  { slug: 'directors-commentary-reel', title: "Director's Commentary: Feature Reel", tier: 'exclusive', cost: 3, dur: 3322, cat: 'events',
    desc: 'The creative director walks the latest reel scene by scene.' },
  { slug: 'founders-qa-unfiltered', title: 'Founders Q&A - Unfiltered', tier: 'exclusive', cost: 5, dur: 4048, cat: 'events',
    desc: 'The full internal Q&A session. Nothing cut.' },
]

console.log('\nSeeding catalog...')

await sql(`
  insert into public.profiles (user_id, email, display_name)
  values ('${CREATOR}', 'catalog-seed@startlands.com', 'START Studio')
  on conflict (user_id) do nothing;
`)

for (const c of CATEGORIES) {
  await sql(`
    insert into public.categories (slug, name, sort_order)
    values ('${c.slug}', '${c.name}', ${c.sort})
    on conflict (slug) do update set name = excluded.name, sort_order = excluded.sort_order;
  `)
}
console.log(`  ${CATEGORIES.length} categories`)

for (const v of VIDEOS) {
  await sql(`
    insert into public.videos
      (title, slug, description, creator_id, status, access_tier, credit_cost,
       duration_seconds, published_at, is_featured, featured_rank)
    values
      ('${v.title.replace(/'/g, "''")}', '${v.slug}', '${v.desc.replace(/'/g, "''")}',
       '${CREATOR}', 'published', '${v.tier}', ${v.cost}, ${v.dur}, now(),
       ${v.featured ? 'true' : 'false'}, ${v.featured ?? 'null'})
    on conflict (slug) do update set
      title = excluded.title,
      description = excluded.description,
      access_tier = excluded.access_tier,
      credit_cost = excluded.credit_cost,
      duration_seconds = excluded.duration_seconds;

    insert into public.video_categories (video_id, category_id, is_primary)
    select v.id, c.id, true
    from public.videos v, public.categories c
    where v.slug = '${v.slug}' and c.slug = '${v.cat}'
    on conflict (video_id, category_id) do nothing;
  `)
}
console.log(`  ${VIDEOS.length} videos (no provider assets yet - playback 409s until Phase 1 ingest)`)

const counts = await sql(`
  select access_tier, count(*)::int as n from public.videos
  where slug in (${VIDEOS.map((v) => `'${v.slug}'`).join(',')})
  group by access_tier
`)
console.log(`  tiers: ${counts.map((c) => `${c.access_tier}=${c.n}`).join(', ')}`)
console.log('\nDone. Browse http://localhost:3001/browse\n')
