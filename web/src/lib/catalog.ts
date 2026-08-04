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

export async function featuredSeries(supabase: Client, limit = 8): Promise<(CardSeries & { synopsis: string | null })[]> {
  const { data } = await supabase
    .from('series')
    .select(`${SERIES_CARD_COLUMNS}, synopsis`)
    .eq('status', 'published')
    .is('deleted_at', null)
    .eq('is_featured', true)
    .order('featured_rank', { ascending: true, nullsFirst: false })
    .limit(limit)
  return (data ?? []) as (CardSeries & { synopsis: string | null })[]
}

export async function newSeries(supabase: Client, limit = 12): Promise<CardSeries[]> {
  const { data } = await supabase
    .from('series')
    .select(SERIES_CARD_COLUMNS)
    .eq('status', 'published')
    .is('deleted_at', null)
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
    .select(`${SERIES_CARD_COLUMNS}, synopsis, creator_id, status, published_at`)
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle()
  return (data ?? null) as SeriesDetail | null
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
    .filter((s): s is CardSeries => Boolean(s))
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

/** FTS at the series grain — one hit per show, never fifty episode rows. */
export async function searchSeries(supabase: Client, query: string, limit = 24): Promise<CardSeries[]> {
  const q = query.trim().slice(0, 100)
  if (!q) return []

  const { data: fts } = await supabase
    .from('series')
    .select(SERIES_CARD_COLUMNS)
    .eq('status', 'published')
    .is('deleted_at', null)
    .textSearch('search_tsv', q, { type: 'websearch', config: 'english' })
    .limit(limit)
  if (fts?.length) return fts as CardSeries[]

  const { data: like } = await supabase
    .from('series')
    .select(SERIES_CARD_COLUMNS)
    .eq('status', 'published')
    .is('deleted_at', null)
    .ilike('title', `%${q.replace(/[%_]/g, '')}%`)
    .limit(limit)
  return (like ?? []) as CardSeries[]
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
