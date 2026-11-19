import type { Role } from '../auth/roles.js';

export const REPORT_REASONS = ['spam', 'harassment', 'hate_speech', 'scam', 'inappropriate', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export type ReportResolution = 'hidden' | 'removed' | 'handled';

export const RESTRICTION_TYPES = ['muted', 'suspended'] as const;
export type RestrictionType = (typeof RESTRICTION_TYPES)[number];

export interface ReportRow {
  id: string;
  message_id: string;
  room_id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: ReportReason;
  details: string;
  reported_body: string;
  created_at: Date;
  status: ReportStatus;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution: ReportResolution | null;
  resolution_note: string | null;
}

/** A report with everything the moderation queue shows, joined in one query. */
export interface ReportView extends ReportRow {
  reporter_name: string;
  reported_name: string;
  reported_role: Role;
  room_name: string;
  room_slug: string;
  current_body: string;
  hidden_at: Date | null;
  deleted_at: Date | null;
  moderation_reason: string | null;
  resolver_name: string | null;
}

export interface RestrictionRow {
  id: string;
  user_id: string;
  type: RestrictionType;
  reason: string;
  created_by: string;
  created_at: Date;
  expires_at: Date | null;
  lifted_at: Date | null;
  lifted_by: string | null;
  lift_note: string | null;
}

/** What is in force right now for one account. */
export interface ActiveRestrictions { muted: RestrictionRow | null; suspended: RestrictionRow | null }
export const NO_RESTRICTIONS: ActiveRestrictions = { muted: null, suspended: null };
