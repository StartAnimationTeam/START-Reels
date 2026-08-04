import type { Metadata } from 'next'

import { TaxonomyManager } from './TaxonomyManager'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Categories & Facets' }

/**
 * The taxonomy screen: categories (browse shelves) and facets (the chips on
 * series). Both are LIVE data — every picker, search filter and home shelf
 * reads these tables directly, so anything added here is usable everywhere
 * the moment it lands. Reads via staff RLS (inactive categories included);
 * writes through admin-platform, audited.
 */
export default async function AdminCategoriesPage() {
  const supabase = await createServerSupabase()

  const [catRes, tagRes, catUse, tagUse] = await Promise.all([
    supabase.from('categories').select('id, slug, name, sort_order, is_active').order('sort_order').order('name'),
    supabase.from('tags').select('id, slug, name').order('name'),
    supabase.from('series_categories').select('category_id'),
    supabase.from('series_tags').select('tag_id'),
  ])

  // How many series each is attached to — deletion should say what it costs.
  const catCounts = new Map<string, number>()
  for (const row of catUse.data ?? []) catCounts.set(row.category_id, (catCounts.get(row.category_id) ?? 0) + 1)
  const tagCounts = new Map<string, number>()
  for (const row of tagUse.data ?? []) tagCounts.set(row.tag_id, (tagCounts.get(row.tag_id) ?? 0) + 1)

  return (
    <TaxonomyManager
      categories={(catRes.data ?? []).map((c) => ({ ...c, usedBy: catCounts.get(c.id) ?? 0 }))}
      tags={(tagRes.data ?? []).map((t) => ({ ...t, usedBy: tagCounts.get(t.id) ?? 0 }))}
    />
  )
}
