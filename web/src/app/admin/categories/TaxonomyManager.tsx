'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

/**
 * Add / rename / hide / delete for categories and facets. Every button rides
 * admin-platform (administrator-only, audited). Deleting names its cost —
 * "used by N series" — and detaches cleanly via FK cascade; hiding a
 * category (Active off) pulls it from browse without touching any series.
 */

interface CategoryRow {
  id: string
  slug: string
  name: string
  sort_order: number
  is_active: boolean
  usedBy: number
}

interface TagRow {
  id: string
  slug: string
  name: string
  usedBy: number
}

export function TaxonomyManager({ categories, tags }: { categories: CategoryRow[]; tags: TagRow[] }) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null) // id or 'new-cat'/'new-tag'
  const [error, setError] = useState<{ scope: string; code: string } | null>(null)
  const [newCategory, setNewCategory] = useState('')
  const [newTag, setNewTag] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const run = async (scope: string, fn: () => Promise<unknown>) => {
    setBusy(scope)
    setError(null)
    try {
      await fn()
      setRenaming(null)
      setConfirmDelete(null)
      router.refresh()
      return true
    } catch (err) {
      setError({ scope, code: err instanceof Error ? err.message : 'unknown_error' })
      return false
    } finally {
      setBusy(null)
    }
  }

  const btn =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'
  const input =
    'rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none'

  const errorLine = (scope: string) =>
    error?.scope === scope && (
      <p className="mt-1 text-sm" style={{ color: 'var(--danger)' }}>{errorLabel(error.code)}</p>
    )

  const renameControls = (id: string, save: () => void) => (
    <>
      <input
        autoFocus
        value={renaming?.name ?? ''}
        onChange={(e) => setRenaming({ id, name: e.target.value.slice(0, 80) })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && renaming?.name.trim()) save()
          if (e.key === 'Escape') setRenaming(null)
        }}
        className={`${input} py-1 text-xs`}
      />
      <button
        disabled={busy !== null || !renaming?.name.trim()}
        onClick={save}
        className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
        style={{ background: 'var(--brand-gradient)' }}
      >
        Save
      </button>
      <button disabled={busy !== null} onClick={() => setRenaming(null)} className={btn}>
        Cancel
      </button>
    </>
  )

  const deleteControls = (id: string, usedBy: number, doDelete: () => void) =>
    confirmDelete === id ? (
      <>
        <button
          disabled={busy !== null}
          onClick={doDelete}
          className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          style={{ background: 'var(--danger)' }}
        >
          Confirm — detaches {usedBy} series
        </button>
        <button disabled={busy !== null} onClick={() => setConfirmDelete(null)} className={btn}>
          Keep
        </button>
      </>
    ) : (
      <button disabled={busy !== null} onClick={() => setConfirmDelete(id)} className={btn}>
        Delete…
      </button>
    )

  return (
    <div className="space-y-8">
      {/* ── categories ─────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold tracking-tight">Categories</h2>
        <p className="mt-1 text-sm text-ink-muted">
          The browse shelves — home tabs, category pages, search filters. Hidden categories keep
          their series but disappear from every viewer-facing list.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value.slice(0, 80))}
            onKeyDown={(e) =>
              e.key === 'Enter' &&
              newCategory.trim() &&
              void run('new-cat', () => api.platform('create_category', { name: newCategory.trim() })).then(
                (ok) => ok && setNewCategory(''),
              )
            }
            placeholder="New category name"
            className={`${input} w-full max-w-xs`}
            disabled={busy !== null}
          />
          <button
            disabled={busy !== null || !newCategory.trim()}
            onClick={() =>
              void run('new-cat', () => api.platform('create_category', { name: newCategory.trim() })).then(
                (ok) => ok && setNewCategory(''),
              )
            }
            className="rounded-lg px-4 py-2 text-sm font-medium text-white shadow-[var(--shadow-brand)] disabled:opacity-40"
            style={{ background: 'var(--brand-gradient)' }}
          >
            Add
          </button>
        </div>
        {errorLine('new-cat')}

        <ul className="mt-4 divide-y divide-[var(--border)] rounded-xl border border-line">
          {categories.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className={`min-w-32 text-sm ${c.is_active ? 'text-ink' : 'text-ink-faint line-through'}`}>
                {c.name}
              </span>
              <span className="text-xs text-ink-faint">
                {c.usedBy} series
              </span>

              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {renaming?.id === c.id ? (
                  renameControls(c.id, () =>
                    void run(c.id, () =>
                      api.platform('update_category', { categoryId: c.id, name: renaming!.name.trim() }),
                    ),
                  )
                ) : (
                  <>
                    <button
                      disabled={busy !== null}
                      onClick={() => setRenaming({ id: c.id, name: c.name })}
                      className={btn}
                    >
                      Rename
                    </button>
                    <button
                      disabled={busy !== null}
                      onClick={() =>
                        void run(c.id, () =>
                          api.platform('update_category', { categoryId: c.id, active: !c.is_active }),
                        )
                      }
                      className={btn}
                    >
                      {c.is_active ? 'Hide' : 'Show'}
                    </button>
                    {deleteControls(c.id, c.usedBy, () =>
                      void run(c.id, () => api.platform('delete_category', { categoryId: c.id })),
                    )}
                  </>
                )}
              </div>
              {errorLine(c.id)}
            </li>
          ))}
        </ul>
      </section>

      {/* ── facets ─────────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold tracking-tight">Facets</h2>
        <p className="mt-1 text-sm text-ink-muted">
          The story chips viewers see on series and filter by in search — “Secret Baby”,
          “Revenge”, “Mafia”…
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value.slice(0, 60))}
            onKeyDown={(e) =>
              e.key === 'Enter' &&
              newTag.trim() &&
              void run('new-tag', () => api.platform('create_tag', { name: newTag.trim() })).then(
                (ok) => ok && setNewTag(''),
              )
            }
            placeholder="New facet name"
            className={`${input} w-full max-w-xs`}
            disabled={busy !== null}
          />
          <button
            disabled={busy !== null || !newTag.trim()}
            onClick={() =>
              void run('new-tag', () => api.platform('create_tag', { name: newTag.trim() })).then(
                (ok) => ok && setNewTag(''),
              )
            }
            className="rounded-lg px-4 py-2 text-sm font-medium text-white shadow-[var(--shadow-brand)] disabled:opacity-40"
            style={{ background: 'var(--brand-gradient)' }}
          >
            Add
          </button>
        </div>
        {errorLine('new-tag')}

        <ul className="mt-4 flex flex-wrap gap-2">
          {tags.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5"
            >
              <span className="text-xs text-ink">{t.name}</span>
              <span className="text-[10px] text-ink-faint">{t.usedBy}</span>
              {confirmDelete === t.id ? (
                <>
                  <button
                    disabled={busy !== null}
                    onClick={() => void run(t.id, () => api.platform('delete_tag', { tagId: t.id }))}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white disabled:opacity-40"
                    style={{ background: 'var(--danger)' }}
                  >
                    Confirm ({t.usedBy})
                  </button>
                  <button
                    disabled={busy !== null}
                    onClick={() => setConfirmDelete(null)}
                    className="text-[10px] text-ink-muted hover:text-ink"
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  disabled={busy !== null}
                  onClick={() => setConfirmDelete(t.id)}
                  aria-label={`Delete ${t.name}`}
                  className="text-xs text-ink-faint transition-colors hover:text-[var(--danger)]"
                >
                  ×
                </button>
              )}
              {error?.scope === t.id && (
                <span className="text-[10px]" style={{ color: 'var(--danger)' }}>{errorLabel(error.code)}</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
