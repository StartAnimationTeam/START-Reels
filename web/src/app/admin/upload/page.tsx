import type { Metadata } from 'next'

import { UploadForm } from './UploadForm'

export const metadata: Metadata = { title: 'Upload' }

export default function AdminUploadPage() {
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold tracking-tight">Upload a video</h2>
      <p className="mt-1 text-sm text-ink-muted">
        The file goes straight from your browser to Bunny over a resumable
        connection — a dropped network picks up where it left off. Transcoding
        starts automatically; the video publishes itself when encoding
        finishes.
      </p>
      <div className="mt-6">
        <UploadForm />
      </div>
    </div>
  )
}
