import type { SupabaseClient } from '@supabase/supabase-js'

import type { AccessTier, Database } from './database.types'

/**
 * Catalog reads — every query the browse surface runs, in one place.
 *
 * All of these go through RLS as whoever the client is (anon for the public
 * catalog, the signed-in user for personal rails). None of them can see
 * provider_asset_id: the column grant makes that a database guarantee.
 */

export interface CardVideo {
  id: string
  title: string
  access_tier: AccessTier
  credit_cost: number
  duration_seconds: number | null
  thumbnail_url: string | null
}

export interface HeroVideo extends CardVideo {
  description: string | null
}

type Client = SupabaseClient<Database>

const CARD_COLUMNS = 'id, title, access_tier, credit_cost, duration_seconds, thumbnail_url'

export async function featuredVideos(supabase: Client, limit = 8): Promise<HeroVideo[]> {
  const { data } = await supabase
    .from('videos')
    .select(`${CARD_COLUMNS}, description`)
    .eq('status', 'published')
    .is('deleted_at', null)
    .eq('is_featured', true)
    .order('featured_rank', { ascending: true, nullsFirst: false })
    .limit(limit)
  return (data ?? []) as HeroVideo[]
}

export async function recentVideos(supabase: Client, limit = 12): Promise<CardVideo[]> {
  const { data } = await supabase
    .from('videos')
    .select(CARD_COLUMNS)
    .eq('status', 'published')
    .is('deleted_at', null)
    .order('published_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as CardVideo[]
}

/**
 * Continue watching: partial watches, most recent first. The embed pulls the
 * video through ITS RLS policy, so a video that was unpublished since simply
 * drops out of the rail rather than 404ing on click.
 */
export async function continueWatching(supabase: Client, limit = 12): Promise<CardVideo[]> {
  const { data } = await supabase
    .from('watch_history')
    .select(`last_position_seconds, completed, last_watched_at, videos (${CARD_COLUMNS})`)
    .eq('completed', false)
    .gt('last_position_seconds', 0)
    .order('last_watched_at', { ascending: false })
    .limit(limit)

  return ((data ?? []) as unknown as Array<{ videos: CardVideo | null }>)
    .map((row) => row.videos)
    .filter((v): v is CardVideo => Boolean(v))
}

/** The SQL recommender (0008). Identity comes from the JWT inside the fn. */
export async function recommendedVideos(supabase: Client, limit = 12): Promise<CardVideo[]> {
  const { data } = await supabase.rpc('recommended_videos', { p_limit: limit })
  return (data ?? []) as CardVideo[]
}

export interface CategoryWithVideos {
  id: string
  slug: string
  name: string
  videos: CardVideo[]
}

export async function activeCategories(supabase: Client) {
  const { data } = await supabase
    .from('categories')
    .select('id, slug, name, description')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  return data ?? []
}

export async function videosInCategory(
  supabase: Client,
  categoryId: string,
  limit = 12,
): Promise<CardVideo[]> {
  const { data } = await supabase
    .from('video_categories')
    .select(`videos (${CARD_COLUMNS})`)
    .eq('category_id', categoryId)
    .limit(limit)

  return ((data ?? []) as unknown as Array<{ videos: CardVideo | null }>)
    .map((row) => row.videos)
    .filter((v): v is CardVideo => Boolean(v))
}

/**
 * Full-text search over title+description. `websearch` syntax so quoted
 * phrases and minus-exclusions behave the way people expect from a search
 * box. Falls back to prefix-ILIKE when FTS finds nothing — "rigg" should
 * still find Rigging Masterclass even though it stems to nothing useful.
 */
export async function searchVideos(supabase: Client, query: string, limit = 24): Promise<CardVideo[]> {
  const q = query.trim().slice(0, 100)
  if (!q) return []

  const { data: fts } = await supabase
    .from('videos')
    .select(CARD_COLUMNS)
    .eq('status', 'published')
    .is('deleted_at', null)
    .textSearch('search_tsv', q, { type: 'websearch', config: 'english' })
    .limit(limit)

  if (fts?.length) return fts as CardVideo[]

  const { data: like } = await supabase
    .from('videos')
    .select(CARD_COLUMNS)
    .eq('status', 'published')
    .is('deleted_at', null)
    .ilike('title', `%${q.replace(/[%_]/g, '')}%`)
    .limit(limit)
  return (like ?? []) as CardVideo[]
}

export async function favoriteVideos(supabase: Client, limit = 48): Promise<CardVideo[]> {
  const { data } = await supabase
    .from('favorites')
    .select(`created_at, videos (${CARD_COLUMNS})`)
    .order('created_at', { ascending: false })
    .limit(limit)

  return ((data ?? []) as unknown as Array<{ videos: CardVideo | null }>)
    .map((row) => row.videos)
    .filter((v): v is CardVideo => Boolean(v))
}

export async function isFavorited(supabase: Client, videoId: string): Promise<boolean> {
  const { data } = await supabase.from('favorites').select('video_id').eq('video_id', videoId).limit(1)
  return Boolean(data?.length)
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Series — the browse atom since the pivot. Cards are 9:16 covers; pricing
 * displays from (free_episode_count, episode_credit_cost), the same pair
 * unlock_video charges from.
 * ═══════════════════════════════════════════════════════════════════════ */

export interface CardSeries {
  id: string
  slug: string
  title: string
  cover_url: string | null
  free_episode_count: number
  episode_credit_cost: number
  is_members_only: boolean
  total_episodes: number
}

export interface SeriesDetail extends CardSeries {
  synopsis: string | null
  creator_id: string
  status: Database['public']['Tables']['series']['Row']['status']
  published_at: string | null
  scheduled_publish_at: string | null
}

export interface EpisodeRow {
  id: string
  title: string
  episode_number: number | null
  duration_seconds: number | null
  thumbnail_url: string | null
  status: Database['public']['Tables']['videos']['Row']['status']
}

const SERIES_CARD_COLUMNS =
  'id, slug, title, cover_url, free_episode_count, episode_credit_cost, is_members_only, total_episodes'

// Public shelves exclude EMPTY series (total_episodes = 0): deleting a
// show's last episode must not leave a published ghost shell on the home
// page. The trigger keeps the count honest; trending's MV excludes empties
// by construction (it joins through episodes).
export async function featuredSeries(
  supabase: Client,
  limit = 8,
): Promise<(CardSeries & { synopsis: string | null; hero_url: string | null })[]> {
  const { data } = await supabase
    .from('series')
    .select(`${SERIES_CARD_COLUMNS}, synopsis, hero_url`)
    .eq('status', 'published')
    .is('deleted_at', null)
    .eq('is_featured', true)
    .gt('total_episodes', 0)
    .order('featured_rank', { ascending: true, nullsFirst: false })
    .limit(limit)
  return (data ?? []) as (CardSeries & { synopsis: string | null; hero_url: string | null })[]
}

export async function newSeries(supabase: Client, limit = 12): Promise<CardSeries[]> {
  const { data } = await supabase
    .from('series')
    .select(SERIES_CARD_COLUMNS)
    .eq('status', 'published')
    .is('deleted_at', null)
    .gt('total_episodes', 0)
    .order('published_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as CardSeries[]
}

/** The hourly trending MV, series grain. Public catalog data — anon reads it. */
export async function trendingSeries(supabase: Client, limit = 12): Promise<CardSeries[]> {
  const { data } = await supabase
    .from('mv_trending_series')
    .select(SERIES_CARD_COLUMNS)
    .order('trend_score', { ascending: false })
    .limit(limit)
  return (data ?? []) as CardSeries[]
}

/** The series recommender (0021). Identity comes from the JWT inside the fn. */
export async function recommendedSeries(supabase: Client, limit = 12): Promise<CardSeries[]> {
  const { data } = await supabase.rpc('recommended_series', { p_limit: limit })
  return (data ?? []) as CardSeries[]
}

export async function seriesBySlug(supabase: Client, slug: string): Promise<SeriesDetail | null> {
  const { data } = await supabase
    .from('series')
    .select(`${SERIES_CARD_COLUMNS}, synopsis, creator_id, status, published_at, scheduled_publish_at`)
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle()
  return (data ?? null) as SeriesDetail | null
}

/**
 * Announced-but-unreleased shows, soonest premiere first. Visible to anon
 * through the coming-soon RLS policy (0023); the minutely publisher moves
 * them to published when their moment arrives.
 */
export async function comingSoonSeries(
  supabase: Client,
  limit = 12,
): Promise<Array<CardSeries & { scheduled_publish_at: string }>> {
  const { data } = await supabase
    .from('series')
    .select(`${SERIES_CARD_COLUMNS}, scheduled_publish_at`)
    .eq('status', 'draft')
    .not('scheduled_publish_at', 'is', null)
    .is('deleted_at', null)
    .order('scheduled_publish_at', { ascending: true })
    .limit(limit)
  return (data ?? []) as Array<CardSeries & { scheduled_publish_at: string }>
}

/** Every published episode of a series, in order. RLS keeps drafts invisible. */
export async function seriesEpisodes(supabase: Client, seriesId: string): Promise<EpisodeRow[]> {
  const { data } = await supabase
    .from('videos')
    .select('id, title, episode_number, duration_seconds, thumbnail_url, status')
    .eq('series_id', seriesId)
    .eq('status', 'published')
    .is('deleted_at', null)
    .order('episode_number', { ascending: true })
  return (data ?? []) as EpisodeRow[]
}

export async function seriesInCategory(supabase: Client, categoryId: string, limit = 24): Promise<CardSeries[]> {
  const { data } = await supabase
    .from('series_categories')
    .select(`series (${SERIES_CARD_COLUMNS})`)
    .eq('category_id', categoryId)
    .limit(limit)
  return ((data ?? []) as unknown as Array<{ series: CardSeries | null }>)
    .map((row) => row.series)
    .filter((s): s is CardSeries => s !== null && s.total_episodes > 0)
}

/** Every facet tag, for pickers. The tags table is public-select. */
export async function allTags(supabase: Client): Promise<{ id: string; slug: string; name: string }[]> {
  const { data } = await supabase.from('tags').select('id, slug, name').order('name', { ascending: true })
  return data ?? []
}

/** Facet chips for a series ("Secret Baby", "Revenge", …). */
export async function seriesFacets(supabase: Client, seriesId: string): Promise<{ id: string; slug: string; name: string }[]> {
  const { data } = await supabase
    .from('series_tags')
    .select('tags (id, slug, name)')
    .eq('series_id', seriesId)
  return ((data ?? []) as unknown as Array<{ tags: { id: string; slug: string; name: string } | null }>)
    .map((row) => row.tags)
    .filter((t): t is { id: string; slug: string; name: string } => Boolean(t))
}

export interface SeriesFilters {
  categoryId?: string
  tagId?: string
  /**
   * free = the WHOLE run is watchable without coins (zero cost, or the free
   * window covers every episode); paid = some episodes cost coins; vip =
   * members-only. Free/paid compare two columns, which PostgREST filters
   * can't — that dimension is applied after the fetch.
   */
  access?: 'free' | 'paid' | 'vip'
}

const isEntirelyFree = (s: CardSeries) =>
  s.episode_credit_cost === 0 || s.free_episode_count >= s.total_episodes

function applyAccess(rows: CardSeries[], access: SeriesFilters['access'], limit: number): CardSeries[] {
  if (access === 'free') return rows.filter(isEntirelyFree).slice(0, limit)
  if (access === 'paid') return rows.filter((s) => !isEntirelyFree(s)).slice(0, limit)
  return rows.slice(0, limit)
}

/**
 * Search-and-discover at the series grain — one hit per show, never fifty
 * episode rows. Filters compose with the text query, and an EMPTY query
 * with filters is a browse: "everything in Romance that's free" is a
 * legitimate search with no words in it.
 *
 * Category/facet filtering rides PostgREST inner-join embeds; the join
 * columns are only requested when their filter is active.
 */
export async function searchSeries(
  supabase: Client,
  query: string,
  filters: SeriesFilters = {},
  limit = 24,
): Promise<CardSeries[]> {
  const q = query.trim().slice(0, 100)

  const base = () => {
    const cols = [
      SERIES_CARD_COLUMNS,
      filters.categoryId ? 'series_categories!inner(category_id)' : null,
      filters.tagId ? 'series_tags!inner(tag_id)' : null,
    ]
      .filter(Boolean)
      .join(', ')

    let qb = supabase
      .from('series')
      .select(cols)
      .eq('status', 'published')
      .is('deleted_at', null)
      .gt('total_episodes', 0)
    if (filters.categoryId) qb = qb.eq('series_categories.category_id', filters.categoryId)
    if (filters.tagId) qb = qb.eq('series_tags.tag_id', filters.tagId)
    if (filters.access === 'vip') qb = qb.eq('is_members_only', true)
    return qb
  }

  // free/paid post-filter needs headroom: over-fetch, then trim to limit.
  const fetchLimit = filters.access === 'free' || filters.access === 'paid' ? limit * 4 : limit

  if (!q) {
    const { data } = await base().order('published_at', { ascending: false }).limit(fetchLimit)
    return applyAccess((data ?? []) as unknown as CardSeries[], filters.access, limit)
  }

  const { data: fts } = await base()
    .textSearch('search_tsv', q, { type: 'websearch', config: 'english' })
    .limit(fetchLimit)
  const ftsHits = applyAccess((fts ?? []) as unknown as CardSeries[], filters.access, limit)
  if (ftsHits.length) return ftsHits

  const { data: like } = await base()
    .ilike('title', `%${q.replace(/[%_]/g, '')}%`)
    .limit(fetchLimit)
  return applyAccess((like ?? []) as unknown as CardSeries[], filters.access, limit)
}

/** My List: followed series, newest follow first. */
export async function followedSeries(supabase: Client, limit = 48): Promise<CardSeries[]> {
  const { data } = await supabase
    .from('series_follows')
    .select(`created_at, series (${SERIES_CARD_COLUMNS})`)
    .order('created_at', { ascending: false })
    .limit(limit)
  return ((data ?? []) as unknown as Array<{ series: CardSeries | null }>)
    .map((row) => row.series)
    .filter((s): s is CardSeries => Boolean(s))
}

export async function isFollowed(supabase: Client, seriesId: string): Promise<boolean> {
  const { data } = await supabase.from('series_follows').select('series_id').eq('series_id', seriesId).limit(1)
  return Boolean(data?.length)
}

export interface SeriesProgressRow {
  series_id: string
  last_episode_number: number
  last_position_seconds: number
  last_episode_completed: boolean
  last_watched_at: string
}

/**
 * Continue-watching at the series grain, joined to cards in one round trip
 * less than it sounds: the view row carries the position, the series read
 * carries the card.
 */
export async function continueWatchingSeries(
  supabase: Client,
  limit = 12,
): Promise<Array<{ series: CardSeries; progress: SeriesProgressRow }>> {
  const { data: progress } = await supabase
    .from('series_progress')
    .select('series_id, last_episode_number, last_position_seconds, last_episode_completed, last_watched_at')
    .order('last_watched_at', { ascending: false })
    .limit(limit)
  const rows = (progress ?? []) as SeriesProgressRow[]
  if (!rows.length) return []

  const { data: cards } = await supabase
    .from('series')
    .select(SERIES_CARD_COLUMNS)
    .in('id', rows.map((r) => r.series_id))
    .eq('status', 'published')
    .is('deleted_at', null)
  const byId = new Map(((cards ?? []) as CardSeries[]).map((s) => [s.id, s]))

  return rows
    .map((progress) => ({ series: byId.get(progress.series_id), progress }))
    .filter((r): r is { series: CardSeries; progress: SeriesProgressRow } => Boolean(r.series))
}
