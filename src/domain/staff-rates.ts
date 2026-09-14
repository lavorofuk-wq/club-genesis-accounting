import { rateForMonth, type MonthlyRates, type StaffRecord } from "./gms";

/** ユーザー確認済みの移行月。以前の勤務保存単価は変更しない。 */
export const STAFF_MONTHLY_RATES_START_MONTH = "2026-09";

const validMonth = (month: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

export function staffMonthlyRatesStartMonth(member?: Partial<StaffRecord>) {
  const hireMonth = member?.hiredAt?.slice(0, 7) || "";
  return validMonth(hireMonth) && hireMonth > STAFF_MONTHLY_RATES_START_MONTH
    ? hireMonth : STAFF_MONTHLY_RATES_START_MONTH;
}

/**
 * 初回移行は読取時に行うため、支払済み日次や確定済み集計を書き換えない。
 * 月度設定を初めて保存するときは、この初期月も含めて永続化する。
 * 明示された月度設定がある場合、互換用の単一時給を再混入させない。
 */
export function staffMonthlyRates(member?: Partial<StaffRecord>): MonthlyRates {
  if (member?.hourlyRates && Object.keys(member.hourlyRates).length > 0) {
    return { ...member.hourlyRates };
  }
  const rate = member?.hourlyRate;
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0
    ? { [staffMonthlyRatesStartMonth(member)]: rate } : {};
}

/** 0はその月の月度時給がないことを示す。体入時給・保存単価の選択は呼出元で区別する。 */
export function staffMonthlyRateForMonth(member: Partial<StaffRecord> | undefined, month: string) {
  if (!validMonth(month) || month < STAFF_MONTHLY_RATES_START_MONTH) return 0;
  return rateForMonth(staffMonthlyRates(member), month);
}
