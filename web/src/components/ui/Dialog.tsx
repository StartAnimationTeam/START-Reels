'use client'

import { useEffect, useRef } from 'react'

/**
 * The app's one modal primitive — a thin wrapper over the NATIVE <dialog>
 * element. Chosen over a dependency on purpose: showModal() gives focus
 * trapping, Escape handling, ::backdrop and top-layer stacking from the
 * platform, and this repo has no component library to be consistent with.
 */
export function Dialog({
  open,
  onClose,
  children,
  labelledBy,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  labelledBy?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      // `close` fires for Escape and dialog.close() alike — one exit path.
      onClose={onClose}
      // Click on the backdrop (the dialog element itself, outside the panel)
      // closes; clicks inside the panel hit the panel div, not the dialog.
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className="m-auto w-[min(92vw,26rem)] rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-[var(--shadow-lift)] backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="p-6">{children}</div>
    </dialog>
  )
}
