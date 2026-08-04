'use client'

/**
 * A one-event bus for "the coin balance just changed". Anything that moves
 * value — an unlock, a check-in claim, a promo redemption — announces the
 * delta; the nav badge applies it OPTIMISTICALLY for instant feedback, then
 * re-reads the truth through RLS (the server may settle differently, and the
 * database always wins).
 */

const EVENT = 'coins:changed'

export function announceCoinsDelta(delta: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<{ delta: number }>(EVENT, { detail: { delta } }))
}

export function onCoinsChanged(handler: (delta: number) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<{ delta: number }>).detail?.delta ?? 0)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
