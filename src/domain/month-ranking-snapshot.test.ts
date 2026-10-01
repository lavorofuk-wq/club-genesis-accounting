import { describe, expect, it } from "vitest";
import type { MonthlyAdjustments, WorkspaceData } from "./gms";
import { buildMonthlySnapshot, calculateMonthlyAccounting, MONTHLY_CALCULATION_VERSION, normalizeMonthlyAccountingSnapshot } from "./month-accounting";
import type { CastSalesRankingRoster } from "./cast-sales-ranking";

const month = "2026-09";
const adjustments: MonthlyAdjustments = { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {},
  driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 };
const data: WorkspaceData = { casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [], cashFloat: 0 };
const snapshot = (roster?: CastSalesRankingRoster) => buildMonthlySnapshot(month, 1, "a".repeat(64), adjustments,
  calculateMonthlyAccounting(data, month, adjustments), [], "accountant", "2026-09-30T12:00:00.000Z", roster);
const normalize = (value: unknown) => normalizeMonthlyAccountingSnapshot(value, month, 1);

describe("売上順位表の確定時名簿", () => {
  it("名簿は任意のmetadataとして保存し、計算versionと金額を変更しない", () => {
    const original = snapshot();
    const roster: CastSalesRankingRoster = { schemaVersion: 1, entries: [{ id: "cast-1", name: "在籍" }] };
    const saved = snapshot(roster);
    const { castSalesRankingRoster, ...withoutRoster } = saved;
    expect(castSalesRankingRoster).toEqual(roster);
    expect(withoutRoster).toEqual(original);
    expect(saved.calculationVersion).toBe(MONTHLY_CALCULATION_VERSION);
    expect(normalize(saved)).toEqual(saved);
  });
  it("名簿未保存の旧確定へ現在名簿や空名簿を補完しない", () => {
    const original = snapshot();
    expect(normalize(original)).toEqual(original);
    expect(normalize(original)).not.toHaveProperty("castSalesRankingRoster");
  });
  it("Firebaseが空entriesを省略しても保存済み空名簿と判別できる", () => {
    expect(normalize({ ...snapshot(), castSalesRankingRoster: { schemaVersion: 1 } })?.castSalesRankingRoster)
      .toEqual({ schemaVersion: 1, entries: [] });
  });
  it("Firebaseの数値キー配列を復元し名前を変更しない", () => {
    const roster = { schemaVersion: 1, entries: { 0: { id: "古いID:1", name: "確定時の名前" } } };
    expect(normalize({ ...snapshot(), castSalesRankingRoster: roster })?.castSalesRankingRoster)
      .toEqual({ schemaVersion: 1, entries: [{ id: "古いID:1", name: "確定時の名前" }] });
  });
  it.each([null, 1, "invalid", {}, { schemaVersion: 2 }, { schemaVersion: 1, entries: "invalid" },
    { schemaVersion: 1, unknown: true }, { schemaVersion: 1, entries: [{ id: "", name: "名前" }] },
    { schemaVersion: 1, entries: [{ id: "a", name: "" }] }, { schemaVersion: 1, entries: [{ id: "a", name: " " }] },
    { schemaVersion: 1, entries: [{ id: "a", name: "名前", unknown: true }] },
    { schemaVersion: 1, entries: [{ id: "a", name: "名前" }, { id: "a", name: "別名" }] },
  ])("不正名簿 %j は例外で画面を落とさず月次全体を拒否する", (roster) => {
    expect(() => normalize({ ...snapshot(), castSalesRankingRoster: roster })).not.toThrow();
    expect(normalize({ ...snapshot(), castSalesRankingRoster: roster })).toBeUndefined();
  });
});
