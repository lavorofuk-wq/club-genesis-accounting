import { describe, expect, it } from "vitest";
import { staffMonthlyRateForMonth, staffMonthlyRates, staffMonthlyRatesStartMonth } from "./staff-rates";

describe("スタッフ月度時給の移行・引継ぎ", () => {
  it("既存の単一時給を9月度へ引き継ぎ、8月以前へは適用しない", () => {
    const staff = { hourlyRate: 1400, hiredAt: "2026-01-01" };
    expect(staffMonthlyRates(staff)).toEqual({ "2026-09": 1400 });
    expect(staffMonthlyRateForMonth(staff, "2026-08")).toBe(0);
    expect(staffMonthlyRateForMonth(staff, "2026-09")).toBe(1400);
    expect(staffMonthlyRateForMonth(staff, "2026-10")).toBe(1400);
    expect(staff).toEqual({ hourlyRate: 1400, hiredAt: "2026-01-01" });
  });

  it("10月以降の採用者の単一時給を採用前に適用しない", () => {
    const staff = { hourlyRate: 1500, hiredAt: "2026-11-01" };
    expect(staffMonthlyRatesStartMonth(staff)).toBe("2026-11");
    expect(staffMonthlyRateForMonth(staff, "2026-10")).toBe(0);
    expect(staffMonthlyRateForMonth(staff, "2026-11")).toBe(1500);
  });

  it("月ごとの変更を保持し、将来単価を過去へ反映しない", () => {
    const staff = { hourlyRate: 1300, hourlyRates: { "2026-09": 1400, "2026-11": 1600 } };
    expect(staffMonthlyRateForMonth(staff, "2026-09")).toBe(1400);
    expect(staffMonthlyRateForMonth(staff, "2026-10")).toBe(1400);
    expect(staffMonthlyRateForMonth(staff, "2026-11")).toBe(1600);
    expect(staffMonthlyRateForMonth(staff, "2027-01")).toBe(1600);
    const copy = staffMonthlyRates(staff);
    copy["2026-09"] = 9999;
    expect(staff.hourlyRates["2026-09"]).toBe(1400);
  });

  it("明示月度があれば互換単一時給から別の月を補わない", () => {
    const staff = { hourlyRate: 9999, hourlyRates: { "2026-11": 1600 } };
    expect(staffMonthlyRateForMonth(staff, "2026-09")).toBe(0);
    expect(staffMonthlyRates(staff)).toEqual({ "2026-11": 1600 });
  });

  it("未設定や0円の旧時給を有効な月度単価として扱わない", () => {
    for (const staff of [undefined, {}, { hourlyRate: 0 }, { hourlyRate: -1 }, { hourlyRate: Number.NaN }]) {
      expect(staffMonthlyRates(staff)).toEqual({});
      expect(staffMonthlyRateForMonth(staff, "2026-09")).toBe(0);
    }
    expect(staffMonthlyRateForMonth({ hourlyRate: 1400 }, "2026-13")).toBe(0);
  });
});
