import type { AccountingWorkspaceData, AccountingMonthState } from "./month-accounting";
import type { CastAccountingInput, MonthlyAdjustments } from "./gms";
import type { BeautyMonth } from "./beauty-allowance";
import type { TransportMonth, TransportSettings } from "./transport";

/** 送迎・美容室画面に必要な当月だけの最新読取結果。他画面は全体再読込後に開く。 */
export type WorkAllowanceRefresh = Pick<AccountingWorkspaceData, "casts" | "archivedCasts" | "drivers" | "closings"> & {
  month: string;
  monthState?: AccountingMonthState;
  transportSettings: TransportSettings;
  transportMonth: TransportMonth;
  beautyMonth: BeautyMonth;
  adjustment?: MonthlyAdjustments;
  legacyInputs: CastAccountingInput[];
  legacyRemote: Record<string, number>;
};

export function mergeWorkAllowanceRefresh(current: AccountingWorkspaceData, fresh: WorkAllowanceRefresh): AccountingWorkspaceData {
  const { month } = fresh;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
    || fresh.closings.some((row) => !row.businessDate.startsWith(month + "-"))
    || (fresh.monthState !== undefined && fresh.monthState.month !== month)
    || (fresh.adjustment !== undefined && fresh.adjustment.month !== month)) {
    throw new Error("送迎・美容室の読込対象月が一致しません。");
  }
  // 当月を丸ごと差し替え、他端末で削除された日次・取消された月次状態も残さない。
  const ids = new Set(fresh.closings.map((row) => row.id));
  return {
    ...current, casts: fresh.casts, archivedCasts: fresh.archivedCasts, drivers: fresh.drivers,
    closings: [...current.closings.filter((row) => !row.businessDate.startsWith(month + "-") && !ids.has(row.id)), ...fresh.closings]
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate)),
    monthStates: [...current.monthStates.filter((row) => row.month !== month), ...(fresh.monthState ? [fresh.monthState] : [])],
    transportSettings: fresh.transportSettings,
    transportMonths: { ...current.transportMonths, [month]: fresh.transportMonth },
    beautyMonths: { ...current.beautyMonths, [month]: fresh.beautyMonth },
    adjustments: [...current.adjustments.filter((row) => row.month !== month), ...(fresh.adjustment ? [fresh.adjustment] : [])],
    transportLegacyInputs: { ...current.transportLegacyInputs, [month]: fresh.legacyInputs },
    transportLegacyRemote: { ...current.transportLegacyRemote, [month]: fresh.legacyRemote },
  };
}
