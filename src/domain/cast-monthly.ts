import { castIdentityForMonth, castIntroducerForApprovedWork, castIntroducerOverrideForAccounting,
  compareIntroducerMonthEventEffectiveOrder, japanMonthFromTimestamp, rateForMonth } from "./gms";
import type { CastRecord, DailyCast, DailyClosing, IntroducerDeletionCommit, IntroducerMonthEvent, PersonStatus, WorkspaceData } from "./gms";
import { castAccountingAttendanceDays } from "./cast-accounting-inputs";

type IntroducerTerms = NonNullable<DailyCast["introducer"]>;
type CastDisplayData = Pick<WorkspaceData, "closings" | "introducers">
  & { casts?: CastRecord[]; archivedCasts?: CastRecord[]; introducerDeletionCommits?: IntroducerDeletionCommit[]; introducerMonthEvents?: IntroducerMonthEvent[] };

export const isCastMonth = (month: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

export function castStatusForMonth(cast: CastRecord, month: string): PersonStatus | undefined {
  if (!isCastMonth(month) || cast.deletedAt) return undefined;
  if (cast.status === "trial") return cast.trialDate?.slice(0, 7) === month ? "trial" : undefined;
  if (!cast.hiredAt || cast.hiredAt.slice(0, 7) > month) return undefined;
  const departureMonth = cast.departedAt?.slice(0, 7);
  if (!departureMonth) return "active";
  if (departureMonth === month) return "departed";
  return month < departureMonth ? "active" : undefined;
}

export function castHasApprovedWork(closings: DailyClosing[], casts: CastRecord[], month: string, castId: string) {
  return castAccountingAttendanceDays(closings, casts, month, castId).length > 0;
}

export function castTrialRateOverrideForMonth(cast: CastRecord | undefined, month: string) {
  return rateForMonth(cast?.trialHourlyRates || {}, month);
}

export function castTrialRateForMonth(cast: CastRecord | undefined, month: string) {
  return castTrialRateOverrideForMonth(cast, month) || cast?.trialHourlyRate || 0;
}

export function castIntroducerOverrideForMonth(cast: CastRecord | undefined, month: string): IntroducerTerms | false | undefined {
  const settings = cast?.monthlyIntroducers;
  if (!settings) return undefined;
  const applicable = Object.keys(settings).filter((key) => isCastMonth(key) && key <= month).sort().at(-1);
  return applicable ? settings[applicable] : undefined;
}

export function castSharedIntroducerMemberForMonth(cast: CastRecord, month: string, casts: readonly CastRecord[]): CastRecord {
  if (cast.status !== "trial" || !cast.convertedToCastId) return cast;
  const target = casts.find((row) => row.id === cast.convertedToCastId);
  return target?.hiredAt?.startsWith(`${month}-`) ? target : cast;
}

export function castIntroducerForDisplay(
  cast: CastRecord,
  month: string,
  data: CastDisplayData,
  currentMonth = japanMonthFromTimestamp(new Date().toISOString()),
): IntroducerTerms | undefined {
  const castById = new Map([...(data.archivedCasts || []), ...(data.casts || []), cast].map((row) => [row.id, row]));
  const casts = [...castById.values()];
  const member = castSharedIntroducerMemberForMonth(cast, month, casts);
  const commits = data.introducerDeletionCommits || [];
  const events = data.introducerMonthEvents || [];
  const override = castIntroducerOverrideForAccounting(member.id, castById, month, commits);
  if (override !== undefined) return override || undefined;

  const approved = data.closings.filter((closing) => closing.status === "approved" && closing.businessDate.startsWith(`${month}-`));
  const monthRegularIds = new Set(approved.flatMap((closing) => (closing.casts || [])
    .filter((row) => row.kind === "regular").map((row) => row.masterId)));
  const entries = approved.flatMap((closing) => (closing.casts || [])
    .filter((row) => castIdentityForMonth(row, castById, casts, month, monthRegularIds) === member.id)
    .map((row) => ({ closing, row })));
  if (entries.length) {
    return castIntroducerForApprovedWork(member.id, castById, month, entries, events, commits);
  }

  const event = events.filter((row) => row.month === month && row.castId === member.id)
    .sort(compareIntroducerMonthEventEffectiveOrder).at(-1);
  if (event?.state === "deleted") return undefined;
  if (event?.state === "reassigned") return event.introducer;
  if (month < currentMonth) return undefined;
  const intro = data.introducers.find((row) => row.id === member.introducerId);
  if (!intro) return undefined;
  return {
    id: intro.id,
    name: intro.name,
    feeType: intro.feeType,
    attendanceAdvisoryEnabled: intro.attendanceAdvisoryEnabled,
    entryAdvisoryEnabled: intro.entryAdvisoryEnabled,
    attendanceAdvisoryFee: intro.attendanceAdvisoryEnabled ? member.attendanceAdvisoryFee || 0 : 0,
    entryAdvisoryFee: intro.entryAdvisoryEnabled ? member.entryAdvisoryFee || 0 : 0,
  };
}
