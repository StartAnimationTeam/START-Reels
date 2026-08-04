import { redirect } from 'next/navigation'

/**
 * The flat Videos table retired with the Curation page (owner call,
 * 2026-08-04): featuring is series-grain and ordered there, the review
 * queue moved there, and episodes are managed inside their series. The
 * redirect keeps old bookmarks meaning something.
 */
export default function AdminVideosPage() {
  redirect('/admin/curation')
}
