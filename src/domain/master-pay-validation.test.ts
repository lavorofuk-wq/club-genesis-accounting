import { describe, expect, it } from "vitest";
import {
  isPositivePayAmount,
  monthlyRatesForSave,
  validateCastPaySetting,
  validateDriverPaySetting,
  validateStaffPaySetting,
} from "./master-pay-validation";

describe("マスタ報酬額の保存検証", () => {
  it("既存キャストの未登録月へ画面初期値の0円を追加しない", () => {
    const legacy = { "2026-08": 0 };
    expect(monthlyRatesForSave(legacy, "2026-09", 0, false)).toEqual(legacy);
    expect(monthlyRatesForSave(legacy, "2026-09", 1_200, false)).toEqual({
      ...legacy,
      "2026-09": 1_200,
    });
    expect(monthlyRatesForSave({}, "2026-09", 0, true)).toEqual({ "2026-09": 0 });
  });

  it("有限の正数だけを報酬額として認める", () => {
    expect(isPositivePayAmount(1)).toBe(true);
    expect(isPositivePayAmount(0)).toBe(false);
    expect(isPositivePayAmount(-1)).toBe(false);
    expect(isPositivePayAmount(Number.NaN)).toBe(false);
    expect(isPositivePayAmount(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("在籍キャストの月度時給は月ごとに1円以上を要求する", () => {
    expect(() => validateCastPaySetting("active", { "2026-09": 1_200 }, undefined)).not.toThrow();
    expect(() => validateCastPaySetting("active", { "2026-09": 0 }, undefined))
      .toThrow("2026-09月度のキャスト時給は1円以上で入力してください。");
    expect(() => validateCastPaySetting("active", { "2026-13": 1_200 }, undefined))
      .toThrow("キャストの月度時給の対象月が正しくありません。");
    expect(() => validateCastPaySetting("active", {}, undefined))
      .toThrow("キャストの月度時給を1円以上で入力してください。");
  });

  it("既存0円のキャストは不変なら編集でき、別月の正数も追加できる", () => {
    const before = { status: "active" as const, hourlyRates: { "2026-08": 0 }, trialHourlyRate: undefined };
    expect(() => validateCastPaySetting("active", { "2026-08": 0 }, undefined, before)).not.toThrow();
    expect(() => validateCastPaySetting("active", { "2026-08": 0, "2026-09": 1_200 }, undefined, before)).not.toThrow();
    expect(() => validateCastPaySetting("departed", { "2026-08": 0 }, undefined, before)).not.toThrow();
  });

  it("キャストの正数から0円への変更と、新しい0円・負数・NaNを拒否する", () => {
    const before = { status: "active" as const, hourlyRates: { "2026-08": 1_200 }, trialHourlyRate: undefined };
    expect(() => validateCastPaySetting("active", { "2026-08": 0 }, undefined, before)).toThrow();
    expect(() => validateCastPaySetting("active", { "2026-08": 1_200, "2026-09": 0 }, undefined, before)).toThrow();
    expect(() => validateCastPaySetting("active", { "2026-08": -1 }, undefined, before)).toThrow();
    expect(() => validateCastPaySetting("active", { "2026-08": Number.NaN }, undefined, before)).toThrow();
    const invalidLegacy = { status: "active" as const, hourlyRates: { "2026-08": -1 }, trialHourlyRate: undefined };
    expect(() => validateCastPaySetting("active", { "2026-08": -1 }, undefined, invalidLegacy)).toThrow();
  });

  it("体入キャストの体入時給は1円以上を要求する", () => {
    expect(() => validateCastPaySetting("trial", {}, 1)).not.toThrow();
    expect(() => validateCastPaySetting("trial", {}, 0))
      .toThrow("キャストの体入時給は1円以上で入力してください。");
    expect(() => validateCastPaySetting("trial", {}, undefined))
      .toThrow("キャストの体入時給は1円以上で入力してください。");
  });

  it("既存0円の体入キャストは不変なら編集できるが、別区分からの0円転用は拒否する", () => {
    const trialBefore = { status: "trial" as const, hourlyRates: {}, trialHourlyRate: 0 };
    expect(() => validateCastPaySetting("trial", {}, 0, trialBefore)).not.toThrow();
    const activeBefore = { status: "active" as const, hourlyRates: { "2026-09": 0 }, trialHourlyRate: 0 };
    expect(() => validateCastPaySetting("trial", {}, 0, activeBefore)).toThrow();
    expect(() => validateCastPaySetting("active", { "2026-09": 0 }, undefined, trialBefore)).toThrow();
  });

  it("スタッフは区分に応じた時給を1円以上に限定する", () => {
    expect(() => validateStaffPaySetting("active", 1_200, undefined)).not.toThrow();
    expect(() => validateStaffPaySetting("active", 0, undefined))
      .toThrow("スタッフの時給は1円以上で入力してください。");
    expect(() => validateStaffPaySetting("trial", undefined, 1_200)).not.toThrow();
    expect(() => validateStaffPaySetting("trial", undefined, 0))
      .toThrow("スタッフの体入時給は1円以上で入力してください。");
  });

  it("既存0円スタッフの非金額編集・退店・復帰を許容し、金額変更時は正数を要求する", () => {
    const activeBefore = { status: "active" as const, hourlyRate: 0, trialHourlyRate: undefined };
    expect(() => validateStaffPaySetting("active", 0, undefined, activeBefore)).not.toThrow();
    expect(() => validateStaffPaySetting("departed", 0, undefined, activeBefore)).not.toThrow();
    expect(() => validateStaffPaySetting("active", 1_200, undefined, activeBefore)).not.toThrow();
    expect(() => validateStaffPaySetting("active", -1, undefined, activeBefore)).toThrow();
    expect(() => validateStaffPaySetting("active", Number.NaN, undefined, activeBefore)).toThrow();
    const invalidLegacy = { status: "active" as const, hourlyRate: -1, trialHourlyRate: undefined };
    expect(() => validateStaffPaySetting("active", -1, undefined, invalidLegacy)).toThrow();

    const trialBefore = { status: "trial" as const, hourlyRate: undefined, trialHourlyRate: 0 };
    expect(() => validateStaffPaySetting("trial", undefined, 0, trialBefore)).not.toThrow();
    expect(() => validateStaffPaySetting("active", 0, 0, trialBefore)).toThrow();
  });

  it("送迎ドライバーの日給は1円以上を要求する", () => {
    expect(() => validateDriverPaySetting(8_000)).not.toThrow();
    expect(() => validateDriverPaySetting(0))
      .toThrow("送迎ドライバーの日給は1円以上で入力してください。");
  });

  it("既存0円ドライバーは日給不変なら他項目を編集でき、変更時は正数を要求する", () => {
    const legacy = { dailyRate: 0 };
    const positive = { dailyRate: 8_000 };
    expect(() => validateDriverPaySetting(0, legacy)).not.toThrow();
    expect(() => validateDriverPaySetting(8_000, legacy)).not.toThrow();
    expect(() => validateDriverPaySetting(-1, legacy)).toThrow();
    expect(() => validateDriverPaySetting(Number.NaN, legacy)).toThrow();
    expect(() => validateDriverPaySetting(0, positive)).toThrow();
    expect(() => validateDriverPaySetting(-1, { dailyRate: -1 })).toThrow();
  });
});
