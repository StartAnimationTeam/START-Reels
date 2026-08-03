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
