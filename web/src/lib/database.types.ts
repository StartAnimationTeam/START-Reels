/**
 * Database types.
 *
 * PLACEHOLDER — covers only what Phase 0 touches. Once the migrations are
 * applied, replace this file wholesale with generated output:
 *
 *   npx supabase gen types typescript --project-id ioulkocgnprfyofmvnbd \
 *     > web/src/lib/database.types.ts
 *
 * Do not hand-edit it after that point; regenerate. A hand-patched types file
 * drifts from the schema and the drift is invisible until runtime.
 *
 * The shape below mirrors what `supabase gen types` emits — every table needs
 * Row/Insert/Update/Relationships and the schema needs Views, Functions, Enums
 * and CompositeTypes. Omitting any of them makes supabase-js resolve queries to
 * `never`, which surfaces as "Property 'x' does not exist on type 'never'"
 * rather than as a missing-type error.
 */

export type AppRole = 'creator' | 'moderator' | 'administrator'
export type CreditType = 'watch'
export type LedgerStatus = 'pending' | 'committed' | 'reversed'
export type LedgerReason =
  | 'signup_grant'
  | 'daily_reward'
  | 'promo'
  | 'admin_grant'
  | 'watch_debit'
  | 'refund'
  | 'manual_adjustment'
  | 'top_up'

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export type VideoStatus =
  | 'draft'
  | 'uploading'
  | 'processing'
  | 'pending_review'
  | 'published'
  | 'rejected'
  | 'removed'
export type AccessTier = 'free' | 'premium' | 'exclusive'
export type EntitlementSource =
  | 'purchase'
  | 'free_tier'
  | 'creator_own'
  | 'role_bypass'
  | 'promo'
  | 'admin_grant'

export interface Database {
  public: {
    Tables: {
      // NOTE: provider_asset_id and search_tsv are deliberately absent from
      // this Row type. The column grant in 0005 makes them unselectable by
      // clients — the type mirrors what the database will actually return.
      videos: {
        Row: {
          id: string
          title: string
          slug: string
          description: string | null
          creator_id: string
          status: VideoStatus
          access_tier: AccessTier
          credit_cost: number
          provider: string
          duration_seconds: number | null
          thumbnail_url: string | null
          preview_gif_url: string | null
          is_featured: boolean
          featured_rank: number | null
          view_count: number
          total_watch_seconds: number
          rejection_reason: string | null
          published_at: string | null
          created_at: string
          updated_at: string
          deleted_at: string | null
        }
        Insert: never
        Update: never
        Relationships: []
      }
      video_entitlements: {
        Row: {
          id: string
          user_id: string
          video_id: string
          source: EntitlementSource
          credits_charged: number
          ledger_id: string | null
          granted_at: string
          expires_at: string
          revoked_at: string | null
          revoke_reason: string | null
        }
        Insert: never
        Update: never
        Relationships: []
      }
      watch_history: {
        Row: {
          user_id: string
          video_id: string
          last_position_seconds: number
          total_seconds_watched: number
          watch_count: number
          completed: boolean
          first_watched_at: string
          last_watched_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      categories: {
        Row: {
          id: string
          slug: string
          name: string
          description: string | null
          sort_order: number
          is_active: boolean
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      video_categories: {
        Row: { video_id: string; category_id: string; is_primary: boolean }
        Insert: never
        Update: never
        Relationships: []
      }
      favorites: {
        Row: { user_id: string; video_id: string; created_at: string }
        // The one client-writable table — RLS WITH CHECK pins user_id to the
        // caller, and the column grant excludes created_at.
        Insert: { user_id: string; video_id: string }
        Update: never
        Relationships: []
      }
      daily_reward_claims: {
        Row: { user_id: string; claim_date: string; amount: number; ledger_id: string; claimed_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      video_reports: {
        Row: {
          id: string
          reporter_id: string
          video_id: string
          reason: 'inappropriate' | 'copyright' | 'spam' | 'wrong_metadata' | 'other'
          detail: string | null
          status: 'open' | 'reviewing' | 'actioned' | 'dismissed'
          reviewed_by: string | null
          reviewed_at: string | null
          action_taken: string | null
          created_at: string
        }
        Insert: {
          reporter_id: string
          video_id: string
          reason: 'inappropriate' | 'copyright' | 'spam' | 'wrong_metadata' | 'other'
          detail?: string | null
        }
        Update: never
        Relationships: []
      }
      user_warnings: {
        Row: {
          id: string
          user_id: string
          issued_by: string
          severity: 'notice' | 'warning' | 'final'
          reason: string
          related_report_id: string | null
          acknowledged_at: string | null
          created_at: string
        }
        Insert: never
        Update: { acknowledged_at?: string }
        Relationships: []
      }
      promo_campaigns: {
        Row: {
          id: string
          code: string
          name: string
          amount: number
          starts_at: string
          ends_at: string | null
          max_redemptions: number | null
          per_user_limit: number
          is_active: boolean
          created_by: string | null
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      promo_redemptions: {
        Row: { campaign_id: string; user_id: string; ledger_id: string; redeemed_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      platform_daily_stats: {
        Row: {
          day: string
          dau: number
          mau: number
          new_registrations: number
          videos_published: number
          watch_seconds: number
          credits_consumed: number
          credits_granted: number
          unlocks: number
          bunny_watch_seconds: number | null
          storage_bytes: number | null
          computed_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      video_daily_stats: {
        Row: {
          day: string
          video_id: string
          views: number
          unique_viewers: number
          watch_seconds: number
          credits_earned: number
          completions: number
        }
        Insert: never
        Update: never
        Relationships: []
      }
      audit_logs: {
        Row: {
          id: number
          actor_id: string | null
          action: string
          target_type: string | null
          target_id: string | null
          before: Json | null
          after: Json | null
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      profiles: {
        Row: {
          user_id: string
          email: string
          display_name: string | null
          avatar_path: string | null
          bio: string | null
          created_at: string
          updated_at: string
          suspended_at: string | null
          suspended_by: string | null
          suspended_reason: string | null
          suspended_until: string | null
          banned_at: string | null
          banned_by: string | null
          banned_reason: string | null
          deleted_at: string | null
        }
        // The client may only ever update these three. The other columns are
        // revoked at the grant level in 0003_rls_core.sql — a USING clause
        // cannot stop a user setting suspended_at on their own row.
        Insert: never
        Update: {
          display_name?: string | null
          avatar_path?: string | null
          bio?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          user_id: string
          role: AppRole
          granted_by: string | null
          granted_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      credit_ledger: {
        Row: {
          id: string
          user_id: string
          credit_type: CreditType
          amount: number
          status: LedgerStatus
          reason: LedgerReason
          reference_type: string | null
          reference_id: string | null
          metadata: Json
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      creator_applications: {
        Row: {
          id: string
          user_id: string
          status: 'pending' | 'approved' | 'rejected'
          bio: string | null
          portfolio_url: string | null
          submitted_at: string
          reviewed_by: string | null
          reviewed_at: string | null
          decision_note: string | null
        }
        Insert: {
          user_id: string
          bio?: string | null
          portfolio_url?: string | null
        }
        Update: never
        Relationships: []
      }
      notification_preferences: {
        Row: { user_id: string; channels: Json; updated_at: string }
        Insert: never
        Update: { channels?: Json }
        Relationships: []
      }
      platform_settings: {
        Row: {
          key: string
          value: Json
          description: string | null
          updated_by: string | null
          updated_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
    }
    Views: {
      mv_trending_videos: {
        Row: {
          id: string
          title: string
          access_tier: AccessTier
          credit_cost: number
          duration_seconds: number | null
          thumbnail_url: string | null
          trend_score: number
        }
        Relationships: []
      }
      credit_balances: {
        Row: {
          user_id: string
          credit_type: CreditType
          committed_balance: number
          pending_holds: number
          available_balance: number
        }
        Relationships: []
      }
    }
    Functions: {
      claim_daily_reward: {
        Args: Record<string, never>
        Returns: { claimed: number; date: string }
      }
      redeem_promo: {
        Args: { p_code: string }
        Returns: { granted: number; name: string }
      }
      recommended_videos: {
        Args: { p_limit?: number }
        Returns: {
          id: string
          title: string
          slug: string
          access_tier: AccessTier
          credit_cost: number
          duration_seconds: number | null
          thumbnail_url: string | null
        }[]
      }
    }
    Enums: {
      app_role: AppRole
      credit_type: CreditType
      ledger_status: LedgerStatus
      ledger_reason: LedgerReason
      application_status: 'pending' | 'approved' | 'rejected'
    }
    CompositeTypes: Record<never, never>
  }
}
