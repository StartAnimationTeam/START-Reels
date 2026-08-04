import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'

import { HomeTabs, homeTab } from '@/components/HomeTabs'
import { SeriesCard } from '@/components/SeriesCard'
import { SeriesRail } from '@/components/SeriesRail'
import {
  activeCategories,
  continueWatchingSeries,
  featuredSeries,
  newSeries,
  recommendedSeries,
  seriesInCategory,
  trendingSeries,
  type CardSeries,
} from '@/lib/catalog'
import { creditLabel, episodeLabel, seriesPricingLabel } from '@/lib/labels'
import { createAnonSupabase, createServerSupabase } from '@/lib/supabase-server'

/**
 * The home page since the pivot: hero + tab row (Popular / New / Rankings /
 * Categories), DramaBox-shaped. The tab is ?tab= — server-rendered, linkable,
 * back-button-friendly.
 *
 * Two clients, on purpose: PUBLIC shelves read through the anon client so the
 * logged-out page — the top of the signup funnel — is identical work; the
 * PERSONAL shelves read as the signed-in user through RLS and simply don't
 * exist otherwise.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const { tab: rawTab } = await searchParams
  const tab = homeTab(rawTab)
  const anon = createAnonSupabase()

  const featured = await featuredSeries(anon)
  const hero = featured[0]

  return (
    <div className="mx-auto max-w-7xl px-4 pb-24 pt-4 sm:px-6">
      {/* The main-screen search entry: looks like a field, acts like a link.
          Tapping lands on /search with the real input focused — one tap,
          keyboard up, no dead weight of a live search on the home render. */}
      <Link
        href="/search"
        className="mb-4 flex items-center gap-2 rounded-lg border border-line-strong bg-surface-muted px-4 py-2.5 text-sm text-ink-faint transition-colors hover:border-brand hover:text-ink-muted"
      >
        <span aria-hidden>⌕</span>
        Search dramas — “Secret Baby”, “Revenge”…
      </Link>

      {hero && tab === 'popular' && <SeriesHero series={hero} />}

      <div className={hero && tab === 'popular' ? 'mt-8' : 'mt-2'}>
        <HomeTabs active={tab} />
      </div>

      <div className="mt-6">
        {tab === 'popular' && <PopularTab anon={anon} featuredRest={featured.slice(1)} />}
        {tab === 'new' && <NewTab anon={anon} />}
        {tab === 'rankings' && <RankingsTab anon={anon} />}
        {tab === 'categories' && <CategoriesTab anon={anon} />}
      </div>
    </div>
  )
}

type Anon = ReturnType<typeof createAnonSupabase>

function SeriesHero({ series }: { series: CardSeries & { synopsis: string | null } }) {
  return (
    <section
      className="relative -mx-4 overflow-hidden sm:-mx-6 sm:rounded-2xl"
      style={
        series.cover_url
          ? {
              backgroundImage:
                `linear-gradient(75deg, rgb(10 10 13 / 0.94) 30%, rgb(10 10 13 / 0.5) 65%, rgb(10 10 13 / 0.2)), url(${series.cover_url})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center 20%',
            }
          : { background: 'var(--surface-brand)' }
      }
    >
      <div className="flex min-h-[300px] flex-col justify-end p-6 sm:min-h-[380px] sm:p-10">
        <p className="text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--accent-pink)' }}>
          Featured
        </p>
        <h1 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">{series.title}</h1>
        {series.synopsis && (
          <p className="mt-3 max-w-xl text-sm text-ink-secondary sm:text-base line-clamp-3">{series.synopsis}</p>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <Link
            href={`/series/${series.slug}`}
            className="rounded-lg px-6 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform hover:scale-[1.02]"
            style={{ background: 'var(--brand-gradient)' }}
          >
            ▶ Watch
          </Link>
          <span className="text-sm text-ink-muted">
            {episodeLabel(series.total_episodes)} · {seriesPricingLabel(series.free_episode_count, series.episode_credit_cost)}
          </span>
        </div>
      </div>
    </section>
  )
}

async function PopularTab({ anon, featuredRest }: { anon: Anon; featuredRest: CardSeries[] }) {
  const { userId } = await auth()

  const [trending, recent, categories] = await Promise.all([
    trendingSeries(anon),
    newSeries(anon),
    activeCategories(anon),
  ])

  let continueShelf: Awaited<ReturnType<typeof continueWatchingSeries>> = []
  let recommendedShelf: CardSeries[] = []
  if (userId) {
    const supabase = await createServerSupabase()
    ;[continueShelf, recommendedShelf] = await Promise.all([
      continueWatchingSeries(supabase),
      recommendedSeries(supabase),
    ])
  }

  const categoryShelves = (
    await Promise.all(
      categories.slice(0, 4).map(async (category) => ({
        category,
        series: await seriesInCategory(anon, category.id, 12),
      })),
    )
  ).filter((shelf) => shelf.series.length > 0)

  return (
    <>
      <SeriesRail
        title="Continue watching"
        series={continueShelf.map((r) => r.series)}
      />
      <SeriesRail title="Most Trending" series={trending} seeAllHref="/?tab=rankings" />
      <SeriesRail title="For you" series={recommendedShelf} />
      <SeriesRail title="Exclusive Originals" series={featuredRest} />
      <SeriesRail
        title="New Releases"
        series={recent}
        seeAllHref="/?tab=new"
        emptyNote="Nothing published yet — check back soon."
      />
      {categoryShelves.map(({ category, series }) => (
        <SeriesRail
          key={category.id}
          title={category.name}
          series={series}
          seeAllHref={`/category/${category.slug}`}
        />
      ))}
    </>
  )
}

async function NewTab({ anon }: { anon: Anon }) {
  const recent = await newSeries(anon, 24)
  if (!recent.length) {
    return <p className="text-sm text-ink-muted">Nothing published yet — check back soon.</p>
  }
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 lg:grid-cols-6">
      {recent.map((s) => (
        <SeriesCard key={s.id} series={s} />
      ))}
    </div>
  )
}

async function RankingsTab({ anon }: { anon: Anon }) {
  const [trending, fresh] = await Promise.all([trendingSeries(anon, 10), newSeries(anon, 10)])

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-semibold tracking-tight">Most Trending</h2>
      {trending.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          Rankings appear once shows have been watched — the chart refreshes hourly.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {trending.map((s, i) => (
            <RankRow key={s.id} series={s} rank={i + 1} />
          ))}
        </ol>
      )}

      <h2 className="mt-10 text-lg font-semibold tracking-tight">New Releases</h2>
      <ol className="mt-4 space-y-3">
        {fresh.map((s, i) => (
          <RankRow key={s.id} series={s} rank={i + 1} />
        ))}
      </ol>
    </div>
  )
}

function RankRow({ series, rank }: { series: CardSeries; rank: number }) {
  return (
    <li>
      <Link
        href={`/series/${series.slug}`}
        className="flex items-center gap-4 rounded-xl border border-line bg-surface p-3 transition-colors hover:border-line-strong"
      >
        <span
          className={`w-8 shrink-0 text-center text-2xl font-bold tabular-nums ${
            rank <= 3 ? 'brand-gradient-text' : 'text-ink-faint'
          }`}
        >
          {rank}
        </span>
        <div className="h-20 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-muted">
          {series.cover_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={series.cover_url} alt="" loading="lazy" className="h-full w-full object-cover" />
          )}
        </div>
        <div className="min-w-0">
          <h3 className="truncate font-medium text-ink">{series.title}</h3>
          <p className="mt-1 text-xs text-ink-muted">
            {episodeLabel(series.total_episodes)}
            {series.episode_credit_cost > 0 && series.free_episode_count === 0
              ? ` · ${creditLabel(series.episode_credit_cost)}/ep`
              : ''}
          </p>
        </div>
      </Link>
    </li>
  )
}

async function CategoriesTab({ anon }: { anon: Anon }) {
  const categories = await activeCategories(anon)
  const shelves = (
    await Promise.all(
      categories.map(async (category) => ({
        category,
        series: await seriesInCategory(anon, category.id, 12),
      })),
    )
  ).filter((shelf) => shelf.series.length > 0)

  if (!shelves.length) {
    return <p className="text-sm text-ink-muted">No categories yet — check back soon.</p>
  }

  return (
    <>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
        {shelves.map(({ category }) => (
          <Link
            key={category.id}
            href={`/category/${category.slug}`}
            className="whitespace-nowrap rounded-full border border-line bg-surface px-4 py-1.5 text-sm text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
          >
            {category.name}
          </Link>
        ))}
      </div>
      <div className="mt-2">
        {shelves.map(({ category, series }) => (
          <SeriesRail
            key={category.id}
            title={category.name}
            series={series}
            seeAllHref={`/category/${category.slug}`}
          />
        ))}
      </div>
    </>
  )
}
