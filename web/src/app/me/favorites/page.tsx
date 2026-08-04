import { redirect } from 'next/navigation'

/**
 * Favorites became series follows with the pivot (0018 migrated the rows);
 * My List is where they live now.
 */
export default function FavoritesPage() {
  redirect('/my-list')
}
