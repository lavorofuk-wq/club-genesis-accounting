import type { CastRecord, DriverRecord, MonthlyRates, StaffRecord } from "./gms";

const validMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

export const isPositivePayAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * 既存キャストの編集で、未登録月へ画面初期値の0円を意図せず追加しない。
 * 新規登録時は0円も保存候補へ残し、通常の検証で明示的に拒否する。
 */
export function monthlyRatesForSave(
  current: MonthlyRates,
  month: string,
  amount: number,
  requireSelectedMonth: boolean,
) {
  const next = { ...(current || {}) };
  if (requireSelectedMonth || isPositivePayAmount(amount) || Object.hasOwn(next, month)) {
    next[month] = amount;
  }
  return next;
}

const unchangedLegacyAmount = (
  before: unknown,
  next: unknown,
  beforeUsesAmount: boolean,
) => beforeUsesAmount && before === 0 && next === 0;

export function validateCastPaySetting(
  status: CastRecord["status"],
  hourlyRates: MonthlyRates,
  trialHourlyRate: unknown,
  before: Pick<CastRecord, "status" | "hourlyRates" | "trialHourlyRate"> | null = null,
) {
  if (status === "trial") {
    if (!isPositivePayAmount(trialHourlyRate)
      && !unchangedLegacyAmount(before?.trialHourlyRate, trialHourlyRate, before?.status === "trial")) {
      throw new Error("キャストの体入時給は1円以上で入力してください。");
    }
    return;
  }

  const entries = Object.entries(hourlyRates || {});
  if (!entries.length) throw new Error("キャストの月度時給を1円以上で入力してください。");
  for (const [month, amount] of entries) {
    if (!validMonth(month)) throw new Error("キャストの月度時給の対象月が正しくありません。");
    const beforeAmount = before?.hourlyRates?.[month];
    if (!isPositivePayAmount(amount)
      && !unchangedLegacyAmount(beforeAmount, amount, Boolean(before) && before?.status !== "trial")) {
      throw new Error(`${month}月度のキャスト時給は1円以上で入力してください。`);
    }
  }
}

export function validateStaffPaySetting(
  status: StaffRecord["status"],
  hourlyRate: unknown,
  trialHourlyRate: unknown,
  before: Pick<StaffRecord, "status" | "hourlyRate" | "trialHourlyRate"> | null = null,
) {
  if (status === "trial") {
    if (!isPositivePayAmount(trialHourlyRate)
      && !unchangedLegacyAmount(before?.trialHourlyRate, trialHourlyRate, before?.status === "trial")) {
      throw new Error("スタッフの体入時給は1円以上で入力してください。");
    }
    return;
  }
  if (!isPositivePayAmount(hourlyRate)
    && !unchangedLegacyAmount(before?.hourlyRate, hourlyRate, Boolean(before) && before?.status !== "trial")) {
    throw new Error("スタッフの時給は1円以上で入力してください。");
  }
}

export function validateDriverPaySetting(
  dailyRate: DriverRecord["dailyRate"] | unknown,
  before: Pick<DriverRecord, "dailyRate"> | null = null,
) {
  if (!isPositivePayAmount(dailyRate)
    && !unchangedLegacyAmount(before?.dailyRate, dailyRate, Boolean(before))) {
    throw new Error("送迎ドライバーの日給は1円以上で入力してください。");
  }
}
