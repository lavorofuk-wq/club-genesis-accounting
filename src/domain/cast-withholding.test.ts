import { describe, expect, it } from "vitest";
import { calculateCastWithholding } from "./cast-withholding";

describe("在籍キャストの月次源泉所得税", () => {
  it("9月総支給523,500円から全暦日30日分を控除し38,134円とする", () => {
    expect(calculateCastWithholding(523_500, "2026-09")).toBe(38_134);
  });

  it.each([
    ["2026-01", 31], ["2026-02", 28], ["2026-03", 31], ["2026-04", 30],
    ["2026-05", 31], ["2026-06", 30], ["2026-07", 31], ["2026-08", 31],
    ["2026-09", 30], ["2026-10", 31], ["2026-11", 30], ["2026-12", 31], ["2024-02", 29],
    ["1900-02", 28], ["2000-02", 29], ["2100-02", 28], ["2400-02", 29],
    ["0001-02", 28], ["0096-02", 29], ["9999-12", 31],
  ] as const)("%sは全暦日%d日で計算し、実行日やタイムゾーンへ依存しない", (month, days) => {
    expect(calculateCastWithholding(days * 5000 + 10_000, month)).toBe(1021);
    expect(calculateCastWithholding(days * 5000, month)).toBe(0);
  });

  it.each([0, 0.5, Number.MIN_VALUE, 149_999.99, 150_000, 150_000.01, 150_009])(
    "総支給%s円で課税基礎が負または税額1円未満なら0円", (grossPay) => {
      expect(calculateCastWithholding(grossPay, "2026-09")).toBe(0);
    });

  it.each([
    [159_999.99999999997, 1020],
    [160_000, 1021],
    [160_000.00000000003, 1021],
    [160_009.8, 1022],
    [523_500.99, 38_134],
  ])("総支給%s円の端数を途中で丸めず税額%s円を算出する", (grossPay, withholding) => {
    expect(calculateCastWithholding(grossPay, "2026-09")).toBe(withholding);
  });

  it("安全整数上限でも浮動小数の乗算で端数を変えない", () => {
    const expected = Number((BigInt(Number.MAX_SAFE_INTEGER) - 150_000n) * 1021n / 10_000n);
    expect(calculateCastWithholding(Number.MAX_SAFE_INTEGER, "2026-09")).toBe(expected);
  });

  it.each(["", "2026-9", "2026-00", "2026-13", "2026-09-01", "2026-09 ", "2026-09\n", "0000-09", "02026-09"])(
    "不正月%sを黙って計算しない", (month) => {
      expect(() => calculateCastWithholding(523_500, month)).toThrow("対象月");
    });

  it.each([NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
    "不正総支給額%sを0円税として扱わない", (grossPay) => {
      expect(() => calculateCastWithholding(grossPay, "2026-09")).toThrow("総支給額");
    });
});
