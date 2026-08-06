'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useApi, ApiError } from '@/lib/api'
import { announceCoinsDelta } from '@/lib/coins'
import { creditLabel, errorLabel } from '@/lib/labels'

/**
 * "Watch an ad, earn coins" — the web door of the rewarded-ad rail.
 *
 * Google Publisher Tag rewarded web ads: inject gpt.js once, define an
 * out-of-page REWARDED slot, surface it on the user's tap
 * (makeRewardedVisible), and on rewardedSlotGranted claim through the
 * Clerk-authenticated ads-claim endpoint — the server owns every rule
 * (amount, daily cap, min interval); this card only renders outcomes.
 *
 * Without NEXT_PUBLIC_GAM_REWARDED_AD_UNIT the card says "coming soon"
 * honestly (trap #15) — that env var is the Phase B go-live switch.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- GPT global */
declare global {
  interface Window {
    googletag?: any
  }
}

type CardState =
  | 'unconfigured' // no ad unit env — pre-Google-approval
  | 'disabled' // platform setting off
  | 'capped' // daily limit reached
  | 'idle'
  | 'loading' // slot requested, waiting for ready/no-fill
  | 'ready' // makeRewardedVisible available
  | 'watching'
  | 'granted'
  | 'no_fill'
  | 'closed_early'
  | 'unsupported' // defineOutOfPageSlot returned null
  | 'error'

export function RewardedAdCard({
  enabled,
  amount,
  dailyCap,
  todayCount,
  adUnitPath,
}: {
  enabled: boolean
  amount: number
  dailyCap: number
  todayCount: number
  adUnitPath: string | null
}) {
  const api = useApi()
  const router = useRouter()

  const initial: CardState = !adUnitPath
    ? 'unconfigured'
    : !enabled
      ? 'disabled'
      : todayCount >= dailyCap
        ? 'capped'
        : 'idle'
  const [state, setState] = useState<CardState>(initial)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [grantedAmount, setGrantedAmount] = useState(0)
  const [countToday, setCountToday] = useState(todayCount)

  const slotRef = useRef<any>(null)
  const readyEventRef = useRef<any>(null)
  const claimTokenRef = useRef<string>('')

  const destroySlot = useCallback(() => {
    const googletag = window.googletag
    if (googletag?.destroySlots && slotRef.current) {
      googletag.cmd.push(() => googletag.destroySlots([slotRef.current]))
    }
    slotRef.current = null
    readyEventRef.current = null
  }, [])

  useEffect(() => destroySlot, [destroySlot])

  const claim = useCallback(async () => {
    try {
      const res = await api.claimAdReward(claimTokenRef.current)
      setGrantedAmount(res.amount)
      setCountToday((c) => c + 1)
      setState('granted')
      announceCoinsDelta(res.amount)
      router.refresh()
    } catch (err) {
      setErrorCode(err instanceof ApiError ? err.code : 'unknown_error')
      setState('error')
    }
  }, [api, router])

  const loadAd = useCallback(() => {
    if (!adUnitPath) return
    setErrorCode(null)
    setState('loading')
    claimTokenRef.current = crypto.randomUUID()

    const boot = () => {
      const googletag = window.googletag
      googletag.cmd.push(() => {
        destroySlot()
        const slot = googletag.defineOutOfPageSlot(
          adUnitPath,
          googletag.enums.OutOfPageFormat.REWARDED,
        )
        if (!slot) {
          setState('unsupported')
          return
        }
        slot.addService(googletag.pubads())
        slotRef.current = slot

        const pubads = googletag.pubads()
        pubads.addEventListener('rewardedSlotReady', (event: any) => {
          if (event.slot !== slot) return
          readyEventRef.current = event
          setState('ready')
        })
        pubads.addEventListener('rewardedSlotGranted', (event: any) => {
          if (event.slot !== slot) return
          void claim()
        })
        pubads.addEventListener('rewardedSlotClosed', (event: any) => {
          if (event.slot !== slot) return
          destroySlot()
          // Closed without a grant = walked out early; granted state wins
          // if the claim already landed.
          setState((s) => (s === 'watching' ? 'closed_early' : s))
        })
        pubads.addEventListener('slotRenderEnded', (event: any) => {
          if (event.slot !== slot) return
          if (event.isEmpty) {
            destroySlot()
            setState('no_fill')
          }
        })

        googletag.enableServices()
        googletag.display(slot)
      })
    }

    if (window.googletag?.apiReady) {
      boot()
    } else {
      window.googletag = window.googletag || { cmd: [] }
      const existing = document.querySelector<HTMLScriptElement>('script[data-gpt]')
      if (existing) {
        window.googletag.cmd.push(boot)
        return
      }
      const script = document.createElement('script')
      script.src = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'
      script.async = true
      script.dataset.gpt = '1'
      script.onload = boot
      script.onerror = () => setState('error')
      document.head.appendChild(script)
    }
  }, [adUnitPath, destroySlot, claim])

  const show = useCallback(() => {
    if (readyEventRef.current) {
      setState('watching')
      readyEventRef.current.makeRewardedVisible()
    }
  }, [])

  const capped = countToday >= dailyCap
  const primary =
    'w-full rounded-lg px-4 py-3 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.01] disabled:opacity-40'

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-ink-secondary">Watch an ad</h2>
        <span className="text-xs tabular-nums text-ink-faint">
          {Math.min(countToday, dailyCap)}/{dailyCap} today
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        A short video, {creditLabel(amount)} in your wallet. Up to {dailyCap} a day.
      </p>

      <div className="mt-4">
        {state === 'unconfigured' ? (
          // The boundary states itself (trap #15): this flips on when the
          // Google ad unit env var exists — Phase B of the ads plan.
          <p className="text-sm text-ink-muted">
            Almost here — ad serving switches on once our Google approval lands.
          </p>
        ) : state === 'disabled' ? (
          <p className="text-sm text-ink-muted">{errorLabel('ad_rewards_disabled')}</p>
        ) : capped && state !== 'granted' ? (
          <p className="text-sm text-ink-muted">{errorLabel('ad_reward_cap_reached')}</p>
        ) : (
          <>
            {state === 'granted' && (
              <p className="mb-3 text-sm" style={{ color: 'var(--success)' }}>
                +{creditLabel(grantedAmount)} — thanks for watching.
              </p>
            )}
            {state === 'no_fill' && (
              <p className="mb-3 text-sm text-ink-muted">{errorLabel('ad_no_fill')}</p>
            )}
            {state === 'closed_early' && (
              <p className="mb-3 text-sm text-ink-muted">
                The ad closed before the end — no coins that time.
              </p>
            )}
            {state === 'unsupported' && (
              <p className="mb-3 text-sm text-ink-muted">
                Ads aren’t supported in this browser — try your phone.
              </p>
            )}
            {state === 'error' && (
              <p className="mb-3 text-sm" style={{ color: 'var(--danger)' }}>
                {errorLabel(errorCode)}
              </p>
            )}

            {state === 'ready' ? (
              <button onClick={show} className={primary} style={{ background: 'var(--brand-gradient)' }}>
                ▶ Watch now for {creditLabel(amount)}
              </button>
            ) : (
              <button
                onClick={loadAd}
                disabled={state === 'loading' || state === 'watching'}
                className={primary}
                style={{ background: 'var(--brand-gradient)' }}
              >
                {state === 'loading'
                  ? 'Finding an ad…'
                  : state === 'watching'
                    ? 'Enjoy the ad…'
                    : state === 'granted' || state === 'no_fill' || state === 'closed_early' || state === 'error'
                      ? 'Watch another'
                      : `Watch an ad for ${creditLabel(amount)}`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
