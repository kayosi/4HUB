export type ReportReason = 'spam' | 'harassment' | 'hate_speech' | 'scam' | 'inappropriate' | 'other';
export const REPORT_REASONS: { id: ReportReason; label: string }[] = [
  { id: 'spam', label: 'Spam or advertising' },
  { id: 'scam', label: 'Scam or fraud' },
  { id: 'harassment', label: 'Harassment or abuse' },
  { id: 'hate_speech', label: 'Hate speech' },
  { id: 'inappropriate', label: 'Inappropriate content' },
  { id: 'other', label: 'Something else' },
];
export const reasonLabel = (r: string) => REPORT_REASONS.find((x) => x.id === r)?.label ?? r;

export interface RestrictionSummary { id: string; type: 'muted' | 'suspended'; reason: string; createdAt: string; expiresAt: string | null }
export interface UserRestrictions { muted: RestrictionSummary | null; suspended: RestrictionSummary | null }
export const NO_RESTRICTIONS: UserRestrictions = { muted: null, suspended: null };

export type ReportStatus = 'open' | 'resolved' | 'dismissed';
export interface ReportItem {
  id: string;
  status: ReportStatus;
  reason: ReportReason;
  details: string;
  createdAt: string;
  resolution: 'hidden' | 'removed' | 'handled' | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: { displayName: string } | null;
  reporter: { id: string; displayName: string };
  reportedUser: { id: string; displayName: string; role: string; restrictions: UserRestrictions };
  room: { id: string; slug: string; name: string };
  message: {
    id: string;
    state: 'visible' | 'hidden' | 'removed';
    /** Exactly what was reported. */
    snapshot: string;
    current: string | null;
    editedSinceReport: boolean;
    moderationReason: string | null;
    reportCount: number;
  };
}
export interface ReportList { reports: ReportItem[]; counts: Record<ReportStatus, number>; limit: number; offset: number }

/** "until 12 Mar, 14:30" or "until an administrator lifts it". */
export const untilText = (expiresAt: string | null | undefined): string =>
  expiresAt ? `until ${new Date(expiresAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'until an administrator lifts it';
