import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { SeriesCard } from '@/components/SeriesCard'
import { seriesInCategory } from '@/lib/catalog'
import { createAnonSupabase } from '@/lib/supabase-server'

export const revalidate = 60

interface Props {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const { data } = await createAnonSupabase()
    .from('categories')
    .select('name')
    .eq('slug', slug)
    .maybeSingle()
  return { title: data?.name ?? 'Category' }
}

export default async function CategoryPage({ params }: Props) {
  const { slug } = await params
  const supabase = createAnonSupabase()

  const { data: category } = await supabase
    .from('categories')
    .select('id, name, description')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle()

  if (!category) notFound()

  const series = await seriesInCategory(supabase, category.id, 48)

  return (
    <div className="mx-auto max-w-7xl px-4 pb-24 pt-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{category.name}</h1>
      {category.description && <p className="mt-1 text-sm text-ink-muted">{category.description}</p>}

      {series.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">No shows in this category yet.</p>
      ) : (
        <div className="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 lg:grid-cols-6">
          {series.map((s) => (
            <SeriesCard key={s.id} series={s} />
          ))}
        </div>
      )}
    </div>
  )
}
