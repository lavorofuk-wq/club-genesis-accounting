import { compareIntroducerMonthEventEffectiveOrder, japanMonthFromTimestamp, rateForMonth } from "./gms";
import type { CastRecord, DailyCast, DailyClosing, IntroducerDeletionCommit, IntroducerMonthEvent, PersonStatus, WorkspaceData } from "./gms";
import { castAccountingAttendanceDays } from "./cast-accounting-inputs";

type IntroducerTerms = NonNullable<DailyCast["introducer"]>;
type CastDisplayData = Pick<WorkspaceData, "closings" | "introducers">
  & { introducerDeletionCommits?: IntroducerDeletionCommit[]; introducerMonthEvents?: IntroducerMonthEvent[] };

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

export function castIntroducerForDisplay(
  cast: CastRecord,
  month: string,
  data: CastDisplayData,
  currentMonth = japanMonthFromTimestamp(new Date().toISOString()),
): IntroducerTerms | undefined {
  const override = castIntroducerOverrideForMonth(cast, month);
  if (override !== undefined) {
    if (!override || data.introducerDeletionCommits?.some((commit) =>
      commit.introducerId === override.id && commit.month <= month)) return undefined;
    return override;
  }
  const event = data.introducerMonthEvents?.filter((row) => row.month === month && row.castId === cast.id)
    .sort(compareIntroducerMonthEventEffectiveOrder).at(-1);
  if (event?.state === "deleted") return undefined;
  if (event?.state === "reassigned") return event.introducer;
  if (month < currentMonth) {
    const latest = data.closings.filter((closing) => closing.businessDate.slice(0, 7) === month && closing.status !== "withdrawn")
      .flatMap((closing) => closing.casts.filter((row) => row.masterId === cast.id).map((row) => ({ closing, row })))
      .sort((left, right) =>
        (left.closing.submittedAtMs ?? Date.parse(left.closing.submittedAt || left.closing.updatedAt))
        - (right.closing.submittedAtMs ?? Date.parse(right.closing.submittedAt || right.closing.updatedAt))
        || left.closing.businessDate.localeCompare(right.closing.businessDate)).at(-1);
    return latest?.row.introducer;
  }
  const intro = data.introducers.find((row) => row.id === cast.introducerId);
  if (!intro) return undefined;
  return {
    id: intro.id,
    name: intro.name,
    feeType: intro.feeType,
    attendanceAdvisoryEnabled: intro.attendanceAdvisoryEnabled,
    entryAdvisoryEnabled: intro.entryAdvisoryEnabled,
    attendanceAdvisoryFee: intro.attendanceAdvisoryEnabled ? cast.attendanceAdvisoryFee || 0 : 0,
    entryAdvisoryFee: intro.entryAdvisoryEnabled ? cast.entryAdvisoryFee || 0 : 0,
  };
}
