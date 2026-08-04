import { redirect } from 'next/navigation'

/**
 * Standalone uploads retired from the admin surface (owner call, 2026-08-04):
 * in a series-first library every upload is an episode, and the Series pages
 * own that flow end to end. The route redirects rather than 404s so old
 * bookmarks land somewhere useful. (Creators keep their own upload page —
 * the review flow is unchanged.)
 */
export default function AdminUploadPage() {
  redirect('/admin/series')
}
