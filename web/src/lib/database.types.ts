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

export interface Database {
  public: {
    Tables: {
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
    Functions: Record<never, never>
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
